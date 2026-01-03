// ==UserScript==
// @name         Terraforming Titans Galactic Market Automator [Funding-Aware + Autobuild-Safe]
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.1.0
// @description  Auto-manages Galactic Market buy/sell rates with per-resource floors/ceilings, funding-aware prioritization, and autobuild starvation protection.
// @author       kov27
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html-classic.itch.zone/html/*/index.html?*
// @match        https://itch.io/embed-upload/*?color=*
// @match        https://itch.io/embed-upload/*
// @run-at       document-idle
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const SCRIPT_NAME = 'TT Galactic Market Automator';
  const UW = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  /* =========================
   * Shared runtime (same contract as Worker Allocator)
   * ========================= */
  const TT = (function ensureSharedRuntime(scriptName) {
    if (UW.TT_SHARED_RUNTIME && UW.TT_SHARED_RUNTIME.__ok) return UW.TT_SHARED_RUNTIME;

    const rt = {
      __ok: true,
      version: 'shared-1.0',
      locks: new Map(),
      logPrefix: '[TT]',
      async runExclusive(key, fn) {
        const prev = rt.locks.get(key) || Promise.resolve();
        let release;
        const cur = new Promise((res) => (release = res));
        rt.locks.set(key, prev.then(() => cur));
        await prev;
        try { return await fn(); }
        finally {
          release();
          rt.locks.delete(key);
        }
      }
    };
    UW.TT_SHARED_RUNTIME = rt;
    return rt;
  })(SCRIPT_NAME);

  const log = (...args) => console.log(TT.logPrefix, ...args);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const now = () => Date.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function tryParseNum(s, fallback = 0) {
    const n = Number(String(s).trim());
    return Number.isFinite(n) ? n : fallback;
  }

  function fmt2(n) {
    if (!isFinite(n)) return '∞';
    return (Math.round(n * 100) / 100).toLocaleString(undefined, { maximumFractionDigits: 2 });
  }
  function fmtInt(n) {
    if (!isFinite(n)) return '∞';
    return Math.floor(n).toLocaleString();
  }

  /* =========================
   * Storage
   * ========================= */
  const STORE_KEY = 'tt_gal_market_v010';
  const defaultState = {
    enabled: false,
    minimized: false,

    tickMs: 650,
    applyThrottleMs: 650,

    // How quickly to push stock toward floor/ceiling (seconds)
    buyHorizonSec: 10,
    sellHorizonSec: 10,

    // Safety buffers
    reserveSeconds: 8,           // keep at least this many seconds of (consumption + autobuildCost)
    fundingBuffer: 0,            // never spend below this funding
    fundingMinRunwaySec: 20,     // cap net spend so funding lasts at least this long (unless sells cover)

    // Per-resource config:
    // key: "colony:metal" etc
    resources: {
      // enabled, buyFloor, sellCeiling, hardMin, priority, maxBuyRate, maxSellRate
    },

    ui: { panelX: 18, panelY: 520, width: 720 }
  };

  function safeJsonParse(s, fallback) {
    try { return JSON.parse(s); } catch { return fallback; }
  }

  function loadState() {
    const raw = GM_getValue(STORE_KEY, null);
    if (!raw) return structuredClone(defaultState);
    const parsed = safeJsonParse(raw, null);
    if (!parsed) return structuredClone(defaultState);

    const s = structuredClone(defaultState);
    Object.assign(s, parsed);
    s.resources = Object.assign({}, defaultState.resources, parsed.resources || {});
    s.ui = Object.assign({}, defaultState.ui, parsed.ui || {});
    return s;
  }

  function saveState() {
    GM_setValue(STORE_KEY, JSON.stringify(state));
  }

  let state = loadState();

  /* =========================
   * Page access helpers
   * ========================= */
  function getPageProp(name) {
    try {
      if (UW && UW[name] !== undefined) return UW[name];
      if (UW && UW.wrappedJSObject && UW.wrappedJSObject[name] !== undefined) return UW.wrappedJSObject[name];
    } catch {}
    return undefined;
  }

  function injectBridge() {
    if (UW.__TT_MARKET_BRIDGE__) return;

    const code = `
      (function(){
        if (window.__TT_MARKET_BRIDGE__) return;

        function pick(obj, keys){
          const out = {};
          for (const k of keys) out[k] = obj[k];
          return out;
        }

        function getMarketProject(){
          try{
            const pm = window.projectManager;
            if (!pm || !pm.projects) return null;
            return pm.projects.galactic_market || null;
          }catch(e){ return null; }
        }

        function listTradeable(){
          const p = getMarketProject();
          if (!p || !p.attributes || !p.attributes.resourceChoiceGainCost) return [];
          const rcgc = p.attributes.resourceChoiceGainCost;
          const out = [];
          for (const cat in rcgc){
            for (const rk in rcgc[cat]){
              out.push({ cat, rk });
            }
          }
          return out;
        }

        function getAutoBuildCostPerSec(cat, rk){
          try{
            const t = window.autobuildCostTracker;
            if (!t || !t.getAverageCost) return 0;
            return Number(t.getAverageCost(cat, rk) || 0);
          }catch(e){ return 0; }
        }

        function ready(){
          return !!(window.resources && window.projectManager && window.autobuildCostTracker);
        }

        function snapshot(){
          const p = getMarketProject();
          const resources = window.resources;
          const list = listTradeable();

          const funding = (resources.colony && resources.colony.funding) ? pick(resources.colony.funding, ['value','cap','production','consumption','net','unlocked']) : null;

          const outRes = [];
          for (const it of list){
            const r = (resources[it.cat] && resources[it.cat][it.rk]) ? resources[it.cat][it.rk] : null;
            if (!r) continue;

            const autoCost = getAutoBuildCostPerSec(it.cat, it.rk);
            outRes.push({
              key: it.cat + ':' + it.rk,
              cat: it.cat,
              rk: it.rk,
              value: Number(r.value || 0),
              cap: Number(r.cap || 0),
              production: Number(r.production || 0),
              consumption: Number(r.consumption || 0),
              net: Number(r.net || 0),
              unlocked: (r.unlocked !== false),
              autoCost: autoCost,
              autobuildShortage: !!r.autobuildShortage,
            });
          }

          // Market availability: project must be unlocked and completed at least once (repeatCount>0)
          const marketStatus = p ? {
            exists: true,
            unlocked: (p.unlocked !== false),
            repeatCount: Number(p.repeatCount || 0),
            // prices can be fetched via methods on p
          } : { exists: false, unlocked: false, repeatCount: 0 };

          return {
            ts: Date.now(),
            market: marketStatus,
            funding,
            res: outRes
          };
        }

        function apply(orders){
          // orders: { buy:[{cat,rk,qty}], sell:[{cat,rk,qty}] }
          const p = getMarketProject();
          if (!p) return;

          // sanitize to expected selection objects
          p.buySelections = (orders.buy || []).map(o => ({ category: o.cat, name: o.rk, quantity: Number(o.qty || 0) }));
          p.sellSelections = (orders.sell || []).map(o => ({ category: o.cat, name: o.rk, quantity: Number(o.qty || 0) }));

          // UI updates are safe even if UI isn't open (they no-op if elements missing)
          try { if (p.updateSelectedResources) p.updateSelectedResources(); } catch(e){}
          try { if (p.updateTotalCostDisplay) p.updateTotalCostDisplay(); } catch(e){}
        }

        function prices(cat, rk, qtyBuy, qtySell){
          const p = getMarketProject();
          if (!p) return null;
          try{
            const bp = p.getBuyPrice(cat, rk, Number(qtyBuy || 0));
            const sp = p.getSellPrice(cat, rk, Number(qtySell || 0));
            const sat = p.getSaturationSellAmount ? p.getSaturationSellAmount(cat, rk) : null;
            return { buyPrice: Number(bp||0), sellPrice: Number(sp||0), saturation: sat==null?null:Number(sat||0) };
          }catch(e){ return null; }
        }

        window.__TT_MARKET_BRIDGE__ = { ready, snapshot, apply, prices };
      })();
    `;
    const el = document.createElement('script');
    el.textContent = code;
    document.documentElement.appendChild(el);
    el.remove();
  }

  function getApi() {
    // Prefer direct, else bridge.
    const resources = getPageProp('resources');
    const projectManager = getPageProp('projectManager');
    const autobuildCostTracker = getPageProp('autobuildCostTracker');

    if (resources && projectManager && autobuildCostTracker) {
      const p = projectManager.projects && projectManager.projects.galactic_market;
      return {
        ready: () => true,
        snapshot: () => {
          const list = [];
          const rcgc = p && p.attributes && p.attributes.resourceChoiceGainCost;
          if (rcgc) {
            for (const cat in rcgc) for (const rk in rcgc[cat]) list.push({ cat, rk });
          }

          const funding = (resources.colony && resources.colony.funding) ? {
            value: Number(resources.colony.funding.value || 0),
            cap: Number(resources.colony.funding.cap || 0),
            production: Number(resources.colony.funding.production || 0),
            consumption: Number(resources.colony.funding.consumption || 0),
            net: Number(resources.colony.funding.net || 0),
            unlocked: (resources.colony.funding.unlocked !== false),
          } : null;

          const outRes = [];
          for (const it of list) {
            const r = resources[it.cat] && resources[it.cat][it.rk];
            if (!r) continue;
            const autoCost = Number(autobuildCostTracker.getAverageCost(it.cat, it.rk) || 0);
            outRes.push({
              key: it.cat + ':' + it.rk,
              cat: it.cat,
              rk: it.rk,
              value: Number(r.value || 0),
              cap: Number(r.cap || 0),
              production: Number(r.production || 0),
              consumption: Number(r.consumption || 0),
              net: Number(r.net || 0),
              unlocked: (r.unlocked !== false),
              autoCost,
              autobuildShortage: !!r.autobuildShortage,
            });
          }

          const market = p ? {
            exists: true,
            unlocked: (p.unlocked !== false),
            repeatCount: Number(p.repeatCount || 0),
          } : { exists: false, unlocked: false, repeatCount: 0 };

          return { ts: Date.now(), market, funding, res: outRes };
        },
        apply: (orders) => {
          if (!p) return;
          p.buySelections = (orders.buy || []).map(o => ({ category: o.cat, name: o.rk, quantity: Number(o.qty || 0) }));
          p.sellSelections = (orders.sell || []).map(o => ({ category: o.cat, name: o.rk, quantity: Number(o.qty || 0) }));
          try { if (p.updateSelectedResources) p.updateSelectedResources(); } catch {}
          try { if (p.updateTotalCostDisplay) p.updateTotalCostDisplay(); } catch {}
        },
        prices: (cat, rk, qtyBuy, qtySell) => {
          if (!p) return null;
          try {
            const buyPrice = Number(p.getBuyPrice(cat, rk, Number(qtyBuy || 0)) || 0);
            const sellPrice = Number(p.getSellPrice(cat, rk, Number(qtySell || 0)) || 0);
            const saturation = p.getSaturationSellAmount ? Number(p.getSaturationSellAmount(cat, rk) || 0) : null;
            return { buyPrice, sellPrice, saturation };
          } catch { return null; }
        }
      };
    }

    injectBridge();
    const bridge = UW.__TT_MARKET_BRIDGE__ || (UW.wrappedJSObject && UW.wrappedJSObject.__TT_MARKET_BRIDGE__);
    if (!bridge || !bridge.ready || !bridge.ready()) return null;
    return bridge;
  }

  /* =========================
   * Planner
   * ========================= */
  function ensureResCfg(key) {
    if (!state.resources[key]) {
      state.resources[key] = {
        enabled: false,
        buyFloor: 0,
        sellCeiling: 0,
        hardMin: 0,
        priority: 50,
        maxBuyRate: 0,   // 0 = unlimited
        maxSellRate: 0,  // 0 = unlimited
      };
    }
    return state.resources[key];
  }

  function planOrders(snap, api) {
    const funding = snap.funding;
    const marketOk =
      snap.market &&
      snap.market.exists &&
      snap.market.unlocked &&
      snap.market.repeatCount > 0;

    const debug = {
      marketOk,
      totalBuyCostPerSec: 0,
      totalSellGainPerSec: 0,
      netFundingPerSec: 0,
      allocations: []
    };

    if (!marketOk) {
      return { orders: { buy: [], sell: [] }, debug, reason: 'Market not active (complete Galactic Market project once).' };
    }

    const fundingVal = funding ? Number(funding.value || 0) : 0;
    const fundingNet = funding ? Number(funding.net || 0) : 0;
    const fundingBuffer = Math.max(0, Number(state.fundingBuffer || 0));
    const runwaySec = Math.max(5, Number(state.fundingMinRunwaySec || 20));

    // Build needs list
    const wants = [];
    const sells = [];

    for (const r of snap.res) {
      const cfg = ensureResCfg(r.key);

      if (!cfg.enabled) continue;
      if (r.unlocked === false) continue;

      const consTotal = Math.max(0, Number(r.consumption || 0)) + Math.max(0, Number(r.autoCost || 0));
      const reserve = consTotal * Math.max(0, Number(state.reserveSeconds || 0));
      const hardMin = Math.max(0, Number(cfg.hardMin || 0), reserve);

      const buyFloor = Math.max(0, Number(cfg.buyFloor || 0), hardMin);
      const sellCeiling = Math.max(0, Number(cfg.sellCeiling || 0));

      // BUY: if below floor, compute buy rate to reach in buyHorizonSec
      if (buyFloor > 0 && r.value < buyFloor) {
        const need = (buyFloor - r.value);
        let rate = need / Math.max(1, Number(state.buyHorizonSec || 10));
        if (cfg.maxBuyRate > 0) rate = Math.min(rate, Number(cfg.maxBuyRate));
        // Autobuild shortage -> bump urgency a bit
        const urgency = (r.autobuildShortage ? 1.25 : 1.0) * (need / Math.max(1, buyFloor));
        wants.push({
          cat: r.cat, rk: r.rk, key: r.key,
          priority: Number(cfg.priority || 50),
          urgency,
          rate
        });
      }

      // SELL: if above ceiling, compute sell rate to reach in sellHorizonSec
      if (sellCeiling > 0 && r.value > sellCeiling) {
        const excess = (r.value - sellCeiling);
        let rate = excess / Math.max(1, Number(state.sellHorizonSec || 10));
        // Never sell below hardMin
        const maxSafe = Math.max(0, (r.value - hardMin) / Math.max(1, Number(state.sellHorizonSec || 10)));
        rate = Math.min(rate, maxSafe);
        if (cfg.maxSellRate > 0) rate = Math.min(rate, Number(cfg.maxSellRate));
        if (rate > 0) sells.push({ cat: r.cat, rk: r.rk, key: r.key, rate });
      }
    }

    // Compute sell gain estimate (rough; uses current price at that qty)
    // We do sells first so buys can be funded by them.
    const sellOrders = [];
    let sellGainPerSec = 0;
    for (const s of sells) {
      const pr = api.prices ? api.prices(s.cat, s.rk, 0, s.rate) : null;
      const sellPrice = pr ? Number(pr.sellPrice || 0) : 0;
      // Saturation guard (don’t exceed saturation too much)
      if (pr && pr.saturation && pr.saturation > 0) {
        const sat = pr.saturation;
        const capped = Math.min(s.rate, sat * 0.95);
        if (capped <= 0) continue;
        s.rate = capped;
      }
      sellGainPerSec += s.rate * sellPrice;
      sellOrders.push({ cat: s.cat, rk: s.rk, qty: s.rate });
    }

    // Funding budget for buys:
    // We aim to keep funding above buffer and not spend so fast that runway would drop below runwaySec.
    // Available runway spend per sec approx = (fundingVal - buffer)/runwaySec + max(0, fundingNet) + sellGainPerSec
    const spendCapPerSec = Math.max(0, (fundingVal - fundingBuffer) / runwaySec) + Math.max(0, fundingNet) + Math.max(0, sellGainPerSec);

    // Sort buys by priority then urgency
    wants.sort((a, b) => {
      const dp = (b.priority - a.priority);
      if (dp !== 0) return dp;
      return (b.urgency - a.urgency);
    });

    const buyOrders = [];
    let remainingSpend = spendCapPerSec;

    for (const w of wants) {
      if (remainingSpend <= 0) break;
      const pr = api.prices ? api.prices(w.cat, w.rk, w.rate, 0) : null;
      const buyPrice = pr ? Number(pr.buyPrice || 0) : 0;
      if (buyPrice <= 0) continue;

      const maxRateBySpend = remainingSpend / buyPrice;
      const qty = Math.max(0, Math.min(w.rate, maxRateBySpend));
      if (qty <= 0) continue;

      buyOrders.push({ cat: w.cat, rk: w.rk, qty });
      remainingSpend -= qty * buyPrice;

      debug.allocations.push({ key: w.key, qty, buyPrice, costPerSec: qty * buyPrice, priority: w.priority, urgency: w.urgency });
    }

    // Final funding deltas (rough)
    let buyCostPerSec = 0;
    for (const b of buyOrders) {
      const pr = api.prices ? api.prices(b.cat, b.rk, b.qty, 0) : null;
      const buyPrice = pr ? Number(pr.buyPrice || 0) : 0;
      buyCostPerSec += b.qty * buyPrice;
    }

    debug.totalBuyCostPerSec = buyCostPerSec;
    debug.totalSellGainPerSec = sellGainPerSec;
    debug.netFundingPerSec = sellGainPerSec - buyCostPerSec + Math.max(0, fundingNet);

    return { orders: { buy: buyOrders, sell: sellOrders }, debug, reason: null };
  }

  /* =========================
   * UI (Worker Allocator style)
   * ========================= */
  const dom = {};
  let dragging = false;
  let dragOffX = 0;
  let dragOffY = 0;

  function injectStyles() {
    const css = `
      :root { color-scheme: dark; }
      .ttgm-root {
        position: fixed;
        left: ${state.ui.panelX}px;
        top: ${state.ui.panelY}px;
        width: ${state.ui.width}px;
        z-index: 2147483645;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial;
        font-size: 12px;
        color: #e6e6e6;
      }
      .ttgm-panel {
        background: rgba(25,25,28,0.92);
        border: 1px solid rgba(255,255,255,0.10);
        border-radius: 10px;
        box-shadow: 0 10px 30px rgba(0,0,0,0.4);
        overflow: hidden;
        user-select: none;
      }
      .ttgm-head {
        display: flex;
        align-items: center;
        justify-content: space-between;
        padding: 10px 10px;
        background: rgba(45,45,52,0.90);
        border-bottom: 1px solid rgba(255,255,255,0.08);
        cursor: move;
      }
      .ttgm-title { font-weight: 700; letter-spacing: 0.2px; }
      .ttgm-btns { display: flex; gap: 6px; }
      .ttgm-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.15);
        color: #e6e6e6;
        padding: 6px 8px;
        border-radius: 8px;
        cursor: pointer;
      }
      .ttgm-btn:hover { background: rgba(255,255,255,0.06); }
      .ttgm-btn.primary {
        background: rgba(70,120,255,0.25);
        border-color: rgba(70,120,255,0.40);
      }
      .ttgm-btn.danger {
        background: rgba(255,80,80,0.22);
        border-color: rgba(255,80,80,0.35);
      }
      .ttgm-body { padding: 10px; }
      .ttgm-row { display:flex; gap: 10px; align-items:center; margin-bottom: 8px; }
      .ttgm-spacer { flex: 1; }
      .ttgm-pill {
        display: inline-flex;
        gap: 8px;
        align-items: center;
        padding: 6px 8px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.12);
        border-radius: 10px;
      }
      .ttgm-toggle { display:inline-flex; align-items:center; gap:8px; }
      .ttgm-toggle input[type="checkbox"] { transform: translateY(1px); }
      .ttgm-input {
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.15);
        color: #e6e6e6;
        border-radius: 8px;
        padding: 6px 8px;
        outline: none;
      }
      .ttgm-input.small { width: 90px; }
      .ttgm-grid {
        display: grid;
        grid-template-columns: 1.25fr 0.55fr 0.75fr 0.75fr 0.75fr 0.6fr 0.8fr;
        gap: 6px;
        align-items: center;
      }
      .ttgm-grid .hdr { opacity: 0.75; font-weight: 700; padding: 4px 0; }
      .ttgm-cell { padding: 2px 0; }
      .ttgm-muted { opacity: 0.7; }
      .ttgm-hr { height:1px; background: rgba(255,255,255,0.08); margin: 10px 0; }
      .ttgm-status { white-space: pre-wrap; }
    `;
    const style = document.createElement('style');
    style.textContent = css;
    document.head.appendChild(style);
  }

  function el(tag, attrs = {}, children = []) {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.startsWith('on') && typeof attrs[k] === 'function') e.addEventListener(k.slice(2), attrs[k]);
      else e.setAttribute(k, attrs[k]);
    }
    for (const c of children) e.appendChild(c);
    return e;
  }

  function buildUI() {
    injectStyles();

    dom.root = el('div', { class: 'ttgm-root' });
    dom.panel = el('div', { class: 'ttgm-panel' });

    dom.head = el('div', { class: 'ttgm-head' });
    dom.title = el('div', { class: 'ttgm-title', text: 'Galactic Market Automator' });

    dom.btns = el('div', { class: 'ttgm-btns' });
    dom.btnToggle = el('button', {
      class: 'ttgm-btn primary',
      text: state.enabled ? 'Running' : 'Stopped',
      onclick: () => { state.enabled = !state.enabled; saveState(); renderHeader(); }
    });
    dom.btnMin = el('button', {
      class: 'ttgm-btn',
      text: state.minimized ? 'Expand' : 'Minimize',
      onclick: () => { state.minimized = !state.minimized; saveState(); renderAll(); }
    });

    dom.btns.append(dom.btnToggle, dom.btnMin);
    dom.head.append(dom.title, dom.btns);

    // drag
    dom.head.addEventListener('mousedown', (ev) => {
      if (ev.button !== 0) return;
      dragging = true;
      const rect = dom.root.getBoundingClientRect();
      dragOffX = ev.clientX - rect.left;
      dragOffY = ev.clientY - rect.top;
      ev.preventDefault();
    });
    window.addEventListener('mousemove', (ev) => {
      if (!dragging) return;
      const x = ev.clientX - dragOffX;
      const y = ev.clientY - dragOffY;
      dom.root.style.left = x + 'px';
      dom.root.style.top = y + 'px';
      state.ui.panelX = x;
      state.ui.panelY = y;
      saveState();
    });
    window.addEventListener('mouseup', () => { dragging = false; });

    dom.body = el('div', { class: 'ttgm-body' });
    dom.panel.append(dom.head, dom.body);
    dom.root.append(dom.panel);
    document.body.appendChild(dom.root);

    renderAll();
  }

  function renderHeader() {
    dom.btnToggle.textContent = state.enabled ? 'Running' : 'Stopped';
    dom.btnToggle.classList.toggle('danger', state.enabled);
    dom.btnToggle.classList.toggle('primary', !state.enabled);
    dom.btnMin.textContent = state.minimized ? 'Expand' : 'Minimize';
  }

  function renderAll() {
    renderHeader();
    dom.body.innerHTML = '';

    if (state.minimized) {
      dom.body.append(el('div', { class: 'ttgm-muted', text: 'Minimized.' }));
      return;
    }

    const row1 = el('div', { class: 'ttgm-row' }, [
      el('div', { class: 'ttgm-pill' }, [
        el('span', { text: 'Tick (ms):' }),
        (() => {
          const inp = el('input', { class: 'ttgm-input small', value: String(state.tickMs) });
          inp.addEventListener('change', () => { state.tickMs = clamp(tryParseNum(inp.value, 650), 200, 5000); saveState(); });
          return inp;
        })()
      ]),
      el('div', { class: 'ttgm-pill' }, [
        el('span', { text: 'Reserve (s):' }),
        (() => {
          const inp = el('input', { class: 'ttgm-input small', value: String(state.reserveSeconds) });
          inp.addEventListener('change', () => { state.reserveSeconds = clamp(tryParseNum(inp.value, 8), 0, 120); saveState(); });
          return inp;
        })()
      ]),
      el('div', { class: 'ttgm-pill' }, [
        el('span', { text: 'Buy horizon (s):' }),
        (() => {
          const inp = el('input', { class: 'ttgm-input small', value: String(state.buyHorizonSec) });
          inp.addEventListener('change', () => { state.buyHorizonSec = clamp(tryParseNum(inp.value, 10), 1, 120); saveState(); });
          return inp;
        })()
      ]),
      el('div', { class: 'ttgm-pill' }, [
        el('span', { text: 'Sell horizon (s):' }),
        (() => {
          const inp = el('input', { class: 'ttgm-input small', value: String(state.sellHorizonSec) });
          inp.addEventListener('change', () => { state.sellHorizonSec = clamp(tryParseNum(inp.value, 10), 1, 120); saveState(); });
          return inp;
        })()
      ]),
      el('div', { class: 'ttgm-pill' }, [
        el('span', { text: 'Funding buffer:' }),
        (() => {
          const inp = el('input', { class: 'ttgm-input small', value: String(state.fundingBuffer) });
          inp.addEventListener('change', () => { state.fundingBuffer = Math.max(0, tryParseNum(inp.value, 0)); saveState(); });
          return inp;
        })()
      ]),
      el('div', { class: 'ttgm-pill' }, [
        el('span', { text: 'Min runway (s):' }),
        (() => {
          const inp = el('input', { class: 'ttgm-input small', value: String(state.fundingMinRunwaySec) });
          inp.addEventListener('change', () => { state.fundingMinRunwaySec = clamp(tryParseNum(inp.value, 20), 5, 300); saveState(); });
          return inp;
        })()
      ])
    ]);

    dom.body.append(row1, el('div', { class: 'ttgm-hr' }));

    const hdr = el('div', { class: 'ttgm-grid' }, [
      el('div', { class: 'hdr', text: 'Resource' }),
      el('div', { class: 'hdr', text: 'Use' }),
      el('div', { class: 'hdr', text: 'Buy floor' }),
      el('div', { class: 'hdr', text: 'Sell ceil' }),
      el('div', { class: 'hdr', text: 'Hard min' }),
      el('div', { class: 'hdr', text: 'Prio' }),
      el('div', { class: 'hdr', text: 'Live (val / net / auto)' }),
    ]);
    dom.body.append(hdr);

    dom.resList = el('div', {});
    dom.body.append(dom.resList);

    dom.body.append(el('div', { class: 'ttgm-hr' }));
    dom.status = el('div', { class: 'ttgm-status ttgm-muted', text: 'Status: waiting for snapshot...' });
    dom.body.append(dom.status);
  }

  function renderResourceRows(snapshot) {
    if (!dom.resList) return;
    dom.resList.innerHTML = '';

    for (const r of snapshot.res) {
      const cfg = ensureResCfg(r.key);

      const nameCell = el('div', { class: 'ttgm-cell', text: `${r.rk}` });

      const useCell = el('div', { class: 'ttgm-cell' }, [
        (() => {
          const cb = el('input', { type: 'checkbox' });
          cb.checked = !!cfg.enabled;
          cb.addEventListener('change', () => { cfg.enabled = cb.checked; saveState(); });
          return el('label', { class: 'ttgm-toggle' }, [cb, el('span', { text: '' })]);
        })()
      ]);

      const buyCell = el('div', { class: 'ttgm-cell' }, [
        (() => {
          const inp = el('input', { class: 'ttgm-input', value: String(cfg.buyFloor) });
          inp.addEventListener('change', () => { cfg.buyFloor = Math.max(0, tryParseNum(inp.value, 0)); saveState(); });
          return inp;
        })()
      ]);

      const sellCell = el('div', { class: 'ttgm-cell' }, [
        (() => {
          const inp = el('input', { class: 'ttgm-input', value: String(cfg.sellCeiling) });
          inp.addEventListener('change', () => { cfg.sellCeiling = Math.max(0, tryParseNum(inp.value, 0)); saveState(); });
          return inp;
        })()
      ]);

      const hardCell = el('div', { class: 'ttgm-cell' }, [
        (() => {
          const inp = el('input', { class: 'ttgm-input', value: String(cfg.hardMin) });
          inp.addEventListener('change', () => { cfg.hardMin = Math.max(0, tryParseNum(inp.value, 0)); saveState(); });
          return inp;
        })()
      ]);

      const prioCell = el('div', { class: 'ttgm-cell' }, [
        (() => {
          const inp = el('input', { class: 'ttgm-input', value: String(cfg.priority) });
          inp.addEventListener('change', () => { cfg.priority = clamp(Math.floor(tryParseNum(inp.value, 50)), 0, 999); saveState(); });
          return inp;
        })()
      ]);

      const live = ` ${fmtInt(r.value)} / ${fmt2(r.net)}/s / auto ${fmt2(r.autoCost)}/s${r.autobuildShortage ? ' ⚠' : ''}`;
      const liveCell = el('div', { class: 'ttgm-cell ttgm-muted', text: live });

      dom.resList.append(el('div', { class: 'ttgm-grid' }, [nameCell, useCell, buyCell, sellCell, hardCell, prioCell, liveCell]));
    }
  }

  function renderStatus(snapshot, plan) {
    const f = snapshot.funding;
    const fundingText = f
      ? `Funding: ${fmtInt(f.value)} (net ${fmt2(f.net)}/s)`
      : 'Funding: ?';

    const marketText = snapshot.market
      ? `Market: ${snapshot.market.exists ? 'found' : 'missing'}, unlocked=${!!snapshot.market.unlocked}, repeatCount=${snapshot.market.repeatCount}`
      : 'Market: ?';

    if (!plan || plan.reason) {
      dom.status.textContent = `Status:\n${marketText}\n${fundingText}\n${plan && plan.reason ? ('\n' + plan.reason) : ''}`;
      return;
    }

    dom.status.textContent =
      `Status:\n${marketText}\n${fundingText}\n\n` +
      `Planned:\n` +
      `  Buy cost/s: ${fmt2(plan.debug.totalBuyCostPerSec)}\n` +
      `  Sell gain/s: ${fmt2(plan.debug.totalSellGainPerSec)}\n` +
      `  Net funding/s: ${fmt2(plan.debug.netFundingPerSec)}\n` +
      `  Buys: ${plan.orders.buy.length}, Sells: ${plan.orders.sell.length}\n`;
  }

  /* =========================
   * Main loop
   * ========================= */
  let lastUiKey = '';
  let lastApplyAt = 0;

  async function tick() {
    const api = getApi();
    if (!api || !api.ready()) return;

    const snap = api.snapshot();

    const key = snap.res.map(r => r.key).join('|');
    if (!dom.resList || key !== lastUiKey) {
      lastUiKey = key;
      if (!state.minimized) renderResourceRows(snap);
    }

    const plan = planOrders(snap, api);
    if (!state.minimized) renderStatus(snap, plan);

    if (state.enabled && !plan.reason) {
      const t = now();
      if (t - lastApplyAt >= state.applyThrottleMs) {
        lastApplyAt = t;
        await TT.runExclusive('tt-market-apply', async () => {
          api.apply(plan.orders);
        });
      }
    }
  }

  async function loop() {
    while (true) {
      try { await tick(); } catch (e) { console.error(e); }
      await sleep(state.tickMs);
    }
  }

  buildUI();
  loop();

})();
