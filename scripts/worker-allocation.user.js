// ==UserScript==
// @name         Terraforming Titans Worker Allocator (Resources + Market) [Docked Left + Safe Click] v2.0.3
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      2.0.3
// @description  Resource-centric worker allocator with Off/On/Balance + Market Buy/Sell. Docked left slide-out. No UI refresh spam (fixes click lock).
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

  // -----------------------
  // Small shared runtime
  // -----------------------
  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const PAGE = (W && W.wrappedJSObject) ? W.wrappedJSObject : W;

  function log(...a) { try { console.debug('[TTWA]', ...a); } catch {} }
  function warn(...a) { try { console.warn('[TTWA]', ...a); } catch {} }

  function gmGet(k, d) {
    try { return typeof GM_getValue === 'function' ? GM_getValue(k, d) : d; } catch { return d; }
  }
  function gmSet(k, v) {
    try { if (typeof GM_setValue === 'function') GM_setValue(k, v); } catch {}
  }

  function safeNum(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }

  // -----------------------
  // Settings + State
  // -----------------------
  const STORE_KEY = 'ttwa2_resource_state_v1';
  const GLOBAL_KEY = 'ttwa2_global_v1';

  const DEFAULT_GLOBAL = {
    enabled: true,
    expandedWidth: 320,
    collapsedWidth: 26,
    tickMs: 1200,
    workerReservePct: 0.04,      // keep a few workers free
    marketHorizonSec: 20,        // for deficit cover
    marketMaxBuyFracPerTick: 0.01, // 1% cap per tick
    marketSellKeepBase: 0.60,    // keep 60% when selling is allowed
    marketSellKeepWhenBuying: 0.45, // more aggressive funding generation if you're buying
    minFunding: 0,              // keep funding >= 0
  };

  /** rowState[rk] = { mode:'off'|'on'|'balance', producerKey:string|null, weight:number, mBuy:boolean, mSell:boolean } */
  let rowState = gmGet(STORE_KEY, null);
  if (!rowState || typeof rowState !== 'object') rowState = {};

  let globalState = gmGet(GLOBAL_KEY, null);
  if (!globalState || typeof globalState !== 'object') globalState = { ...DEFAULT_GLOBAL };
  globalState = { ...DEFAULT_GLOBAL, ...globalState };

  function saveAll() {
    gmSet(STORE_KEY, rowState);
    gmSet(GLOBAL_KEY, globalState);
  }

  // -----------------------
  // Game bridge (direct)
  // -----------------------
  function getPageProp(name) {
    try { if (PAGE && typeof PAGE[name] !== 'undefined') return PAGE[name]; } catch {}
    try { if (W && typeof W[name] !== 'undefined') return W[name]; } catch {}
    return undefined;
  }

  function effectiveWorkerNeed(b) {
    try {
      const base = (b && typeof b.getTotalWorkerNeed === 'function') ? safeNum(b.getTotalWorkerNeed()) : safeNum(b?.requiresWorker);
      const mult = (b && typeof b.getEffectiveWorkerMultiplier === 'function') ? safeNum(b.getEffectiveWorkerMultiplier()) : 1;
      return base * (mult || 1);
    } catch { return 0; }
  }

  function collectProducedKeys(b) {
    const out = [];
    const prod = b && b.production ? b.production : {};
    for (const cat in prod) {
      if (!prod[cat] || typeof prod[cat] !== 'object') continue;
      // We only care about market-ish & colony/special resources
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
        value: safeNum(r.value),
        cap: safeNum(r.cap),
        prod,
        cons,
        net: prod - cons,
        overflow: safeNum(r.overflowRate),
        unlocked: !!r.unlocked,
      };
    } catch { return null; }
  }

  // Try to find the Galactic Market project robustly.
  function findMarketProject() {
    const projects = getPageProp('projects') || getPageProp('project') || getPageProp('projectManager')?.projects || {};
    if (!projects || typeof projects !== 'object') return null;

    // common: projects.galactic_market
    if (projects['galactic_market']) return { key: 'galactic_market', proj: projects['galactic_market'] };
    if (projects['galacticMarket']) return { key: 'galacticMarket', proj: projects['galacticMarket'] };

    for (const k of Object.keys(projects)) {
      const p = projects[k];
      if (!p || typeof p !== 'object') continue;

      const name = String(p.displayName || p.name || p.title || k).toLowerCase();
      const hasSelections = Array.isArray(p.buySelections) && Array.isArray(p.sellSelections);
      if (hasSelections && (name.includes('galactic') && name.includes('market'))) return { key: k, proj: p };
      if (hasSelections && k.toLowerCase().includes('galactic') && k.toLowerCase().includes('market')) return { key: k, proj: p };
    }
    return null;
  }

  function priceFromProject(proj, side, resId) {
    if (!proj || !resId) return null;
    const fnNames = side === 'buy'
      ? ['getBuyPrice', 'getBuyPriceFor', 'getBuyCost', 'buyPriceFor']
      : ['getSellPrice', 'getSellPriceFor', 'getSellGain', 'sellPriceFor'];

    for (const fn of fnNames) {
      try {
        if (typeof proj[fn] === 'function') {
          const v = proj[fn](resId);
          const n = Number(v);
          if (isFinite(n) && n > 0) return n;
        }
      } catch {}
    }

    const mapNames = side === 'buy'
      ? ['buyPrices', 'buyPrice', 'buyPriceByResource', 'buyPricesByResource', 'pricesBuy']
      : ['sellPrices', 'sellPrice', 'sellPriceByResource', 'sellPricesByResource', 'pricesSell'];

    for (const m of mapNames) {
      try {
        const obj = proj[m];
        if (!obj || typeof obj !== 'object') continue;
        const v = obj[resId];
        const n = Number(v);
        if (isFinite(n) && n > 0) return n;
      } catch {}
    }
    return null;
  }

  function bestEffortStartProject(proj) {
    if (!proj || typeof proj !== 'object') return;
    try {
      if ('autoStart' in proj) proj.autoStart = true;
      if ('isEnabled' in proj) proj.isEnabled = true;
      if ('enabled' in proj) proj.enabled = true;
      if ('run' in proj) proj.run = true;
      if ('running' in proj && proj.running === false) proj.running = true;
      if (typeof proj.setEnabled === 'function') proj.setEnabled(true);
      if (typeof proj.start === 'function') proj.start();
    } catch {}
  }

  function snapshot() {
    const resources = getPageProp('resources');
    const buildings = getPageProp('buildings') || {};
    if (!resources || !resources.colony) return null;

    const pop = safeNum(resources.colony.colonists?.value);
    const popCap = safeNum(resources.colony.colonists?.cap);
    const workerCap = safeNum(resources.colony.workers?.cap);
    const workerFree = safeNum(resources.colony.workers?.value);

    // Always include these market-ish keys even if nothing produces them.
    const alwaysKeys = [
      'colony:metal', 'colony:glass', 'colony:water', 'colony:food',
      'colony:components', 'colony:electronics', 'colony:androids',
      'special:spaceships',
    ];

    const producedSet = {};
    for (const rk of alwaysKeys) producedSet[rk] = true;

    const bList = [];
    for (const key of Object.keys(buildings)) {
      const b = buildings[key];
      if (!b) continue;
      const effNeed = effectiveWorkerNeed(b);
      // Keep even effNeed==0 buildings for producer mapping? (glassSmelter etc)
      const produces = collectProducedKeys(b);
      for (const rk of produces) producedSet[rk] = true;

      bList.push({
        key,
        name: String(b.displayName || b.name || key),
        category: String(b.category || ''),
        unlocked: !!b.unlocked,
        effNeed: effNeed,
        count: safeNum(b.count),
        active: safeNum(b.active),
        autoBuildEnabled: !!b.autoBuildEnabled,
        autoBuildBasis: String(b.autoBuildBasis || 'population'),
        autoBuildPercent: safeNum(b.autoBuildPercent),
        autoActiveEnabled: !!b.autoActiveEnabled,
        produces,
      });
    }

    const res = {};
    for (const rk of Object.keys(producedSet)) {
      const st = getResState(resources, rk);
      if (st) res[rk] = st;
    }

    return { pop, popCap, workerCap, workerFree, buildings: bList, res };
  }

  // Apply building updates, WITHOUT touching anything not specified (Off truly hands-off).
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
      } catch (e) {
        warn('applyBuildingUpdates failed', key, e);
      }
    }
  }

  function applyMarketPlan(plan) {
    const found = findMarketProject();
    if (!found) return;

    const proj = found.proj;
    if (!proj) return;

    // We only mutate selections; NO UI refresh calls.
    const sellSel = [];
    const buySel = [];

    for (const rid of Object.keys(plan.sells || {})) {
      const amt = Math.max(0, Number(plan.sells[rid]) || 0);
      if (amt > 0) sellSel.push({ resource: rid, amount: amt });
    }
    for (const rid of Object.keys(plan.buys || {})) {
      const amt = Math.max(0, Number(plan.buys[rid]) || 0);
      if (amt > 0) buySel.push({ resource: rid, amount: amt });
    }

    try {
      // Common internal formats:
      // - array of {resource, amount}
      // - or array of strings + separate map; we handle both best-effort.
      if (Array.isArray(proj.sellSelections)) proj.sellSelections = sellSel;
      if (Array.isArray(proj.buySelections)) proj.buySelections = buySel;

      // Some builds store maps
      if (proj.sellSelectionMap && typeof proj.sellSelectionMap === 'object') {
        proj.sellSelectionMap = {};
        for (const x of sellSel) proj.sellSelectionMap[x.resource] = x.amount;
      }
      if (proj.buySelectionMap && typeof proj.buySelectionMap === 'object') {
        proj.buySelectionMap = {};
        for (const x of buySel) proj.buySelectionMap[x.resource] = x.amount;
      }

      if (plan.ensureRun) bestEffortStartProject(proj);
    } catch (e) {
      warn('applyMarketPlan failed', e);
    }
  }

  // -----------------------
  // UI (Docked left)
  // -----------------------
  const UI = {
    root: null,
    panel: null,
    rail: null,
    rows: new Map(),
    statusEls: {},
    open: false,
  };

  function ensureRowDefaults(rk) {
    if (!rowState[rk]) {
      rowState[rk] = { mode: 'off', producerKey: null, weight: 1, mBuy: false, mSell: false };
      saveAll();
    } else {
      const r = rowState[rk];
      if (!['off', 'on', 'balance'].includes(r.mode)) r.mode = 'off';
      if (typeof r.weight !== 'number' || !isFinite(r.weight)) r.weight = 1;
      r.weight = Math.max(0, Math.min(10, r.weight));
      r.mBuy = !!r.mBuy;
      r.mSell = !!r.mSell;
      if (r.producerKey != null && typeof r.producerKey !== 'string') r.producerKey = null;
    }
  }

  function formatNum(n) {
    n = Number(n);
    if (!isFinite(n)) return '0';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    const units = [
      { v: 1e12, s: 'T' },
      { v: 1e9, s: 'B' },
      { v: 1e6, s: 'M' },
      { v: 1e3, s: 'k' },
    ];
    for (const u of units) {
      if (abs >= u.v) return `${sign}${(abs / u.v).toFixed(abs >= u.v * 10 ? 1 : 2)}${u.s}`;
    }
    return `${sign}${abs.toFixed(abs >= 100 ? 0 : 2)}`;
  }

  function humanResourceName(rk) {
    const [cat, res] = rk.split(':');
    const nice = res.replace(/([A-Z])/g, ' $1').replace(/^./, c => c.toUpperCase());
    if (cat === 'special') return `${nice}`;
    return nice;
  }

  function buildUI() {
    if (UI.root) return;

    const root = document.createElement('div');
    root.id = 'ttwa2-root';
    // IMPORTANT: root itself does NOT capture clicks
    root.style.pointerEvents = 'none';

    const rail = document.createElement('div');
    rail.id = 'ttwa2-rail';
    rail.style.pointerEvents = 'auto';

    const panel = document.createElement('div');
    panel.id = 'ttwa2-panel';
    panel.style.pointerEvents = 'auto';

    root.appendChild(rail);
    root.appendChild(panel);
    document.body.appendChild(root);

    const css = document.createElement('style');
    css.textContent = `
#ttwa2-root{
  position:fixed; top:0; left:0; height:100vh; z-index:999999;
}
#ttwa2-rail{
  position:fixed; top:0; left:0; height:100vh;
  width: var(--ttwa2-railw, 26px);
  background: rgba(0,0,0,0.10);
}
#ttwa2-panel{
  position:fixed; top:0; left:0; height:100vh;
  width: var(--ttwa2-panelw, 320px);
  transform: translateX(calc(var(--ttwa2-railw, 26px) - var(--ttwa2-panelw, 320px)));
  transition: transform 140ms ease;
  background: rgba(25,25,28,0.96);
  color: #e6e6e6;
  font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  border-right: 1px solid rgba(255,255,255,0.08);
  box-shadow: 2px 0 10px rgba(0,0,0,0.35);
  overflow:hidden;
}
#ttwa2-panel.ttwa2-open{
  transform: translateX(0);
}
#ttwa2-panel .ttwa2-head{
  display:flex; align-items:center; justify-content:space-between;
  padding:8px 10px; gap:8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
}
#ttwa2-panel .ttwa2-title{
  font-weight: 700; letter-spacing: .2px;
}
#ttwa2-panel button{
  background: rgba(255,255,255,0.08);
  color:#eee;
  border: 1px solid rgba(255,255,255,0.10);
  padding: 4px 8px;
  border-radius: 6px;
  cursor:pointer;
}
#ttwa2-panel button:hover{ background: rgba(255,255,255,0.12); }
#ttwa2-panel .ttwa2-body{
  height: calc(100vh - 44px);
  overflow:auto;
  padding: 10px;
}
.ttwa2-card{
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(0,0,0,0.18);
  border-radius: 10px;
  padding: 8px;
  margin-bottom: 10px;
}
.ttwa2-grid2{
  display:grid; grid-template-columns: 1fr 1fr; gap:6px 10px;
}
.ttwa2-muted{ opacity: .80; }
.ttwa2-rows{
  display:flex; flex-direction:column; gap:8px;
}
.ttwa2-row{
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 10px;
  padding: 8px;
  background: rgba(0,0,0,0.15);
}
.ttwa2-row .top{
  display:flex; align-items:center; justify-content:space-between; gap:8px;
}
.ttwa2-row .name{
  font-weight:700;
}
.ttwa2-row .bar{
  height: 6px; background: rgba(255,255,255,0.10); border-radius: 99px; overflow:hidden; margin-top:6px;
}
.ttwa2-row .bar > i{
  display:block; height: 100%; width:0%;
  background: rgba(120,220,120,0.9);
}
.ttwa2-row .mini{
  display:flex; gap:10px; margin-top:6px;
  opacity:.9;
}
.ttwa2-row .mini span{ white-space:nowrap; }
.ttwa2-row .ctrl{
  display:grid;
  grid-template-columns: 1fr 1fr;
  gap:6px 8px;
  margin-top:8px;
}
.ttwa2-row select, .ttwa2-row input[type="number"]{
  width: 100%;
  background: rgba(255,255,255,0.06);
  color:#eee;
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 8px;
  padding: 4px 6px;
}
.ttwa2-row label.chk{
  display:flex; align-items:center; gap:6px;
  user-select:none;
}
.ttwa2-row .disabled{
  opacity: .55;
}
`;
    document.head.appendChild(css);

    panel.innerHTML = `
      <div class="ttwa2-head">
        <div class="ttwa2-title">TT Worker Allocator</div>
        <div style="display:flex; gap:6px;">
          <button id="ttwa2-toggle">${globalState.enabled ? 'Stop' : 'Start'}</button>
        </div>
      </div>
      <div class="ttwa2-body">
        <div class="ttwa2-card">
          <div class="ttwa2-grid2">
            <div><span class="ttwa2-muted">Workers</span> <b id="ttwa2-workers">–</b></div>
            <div><span class="ttwa2-muted">Free</span> <b id="ttwa2-free">–</b></div>
            <div><span class="ttwa2-muted">Pop</span> <b id="ttwa2-pop">–</b></div>
            <div><span class="ttwa2-muted">Funding</span> <b id="ttwa2-funding">–</b></div>
          </div>
          <div class="ttwa2-muted" style="margin-top:6px;">
            Off = hands off. On = can build. Balance = no building (autobuild off) but still balances activation.
          </div>
        </div>
        <div class="ttwa2-card">
          <div class="ttwa2-muted" style="margin-bottom:6px;">Resources</div>
          <div class="ttwa2-rows" id="ttwa2-rows"></div>
        </div>
      </div>
    `;

    UI.root = root;
    UI.panel = panel;
    UI.rail = rail;
    UI.statusEls = {
      workers: panel.querySelector('#ttwa2-workers'),
      free: panel.querySelector('#ttwa2-free'),
      pop: panel.querySelector('#ttwa2-pop'),
      funding: panel.querySelector('#ttwa2-funding'),
      toggle: panel.querySelector('#ttwa2-toggle'),
      rowsWrap: panel.querySelector('#ttwa2-rows'),
    };

    UI.statusEls.toggle.addEventListener('click', () => {
      globalState.enabled = !globalState.enabled;
      UI.statusEls.toggle.textContent = globalState.enabled ? 'Stop' : 'Start';
      saveAll();
    });

    // Hover open/close
    let hoverTimer = null;
    function setOpen(v) {
      UI.open = !!v;
      UI.panel.classList.toggle('ttwa2-open', UI.open);
      applyDockShift();
    }
    UI.rail.addEventListener('mouseenter', () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      setOpen(true);
    });
    UI.panel.addEventListener('mouseleave', () => {
      if (hoverTimer) clearTimeout(hoverTimer);
      hoverTimer = setTimeout(() => setOpen(false), 120);
    });

    // width variables
    document.documentElement.style.setProperty('--ttwa2-panelw', `${globalState.expandedWidth}px`);
    document.documentElement.style.setProperty('--ttwa2-railw', `${globalState.collapsedWidth}px`);

    setOpen(false);
    applyDockShift();
  }

  function applyDockShift() {
    // Make sure the game content is shifted right by rail or panel width so overlay does not cover.
    const shift = UI.open ? globalState.expandedWidth : globalState.collapsedWidth;

    // Prefer common containers; fall back to body padding
    const candidates = [
      document.querySelector('#game-container'),
      document.querySelector('#app'),
      document.querySelector('#root'),
      document.querySelector('.game'),
      document.querySelector('canvas')?.parentElement,
    ].filter(Boolean);

    let applied = false;
    for (const el of candidates) {
      try {
        el.style.marginLeft = `${shift}px`;
        applied = true;
      } catch {}
    }

    try {
      // always apply padding-left as a fallback for clicks/layout
      document.body.style.paddingLeft = `${shift}px`;
    } catch {}

    // rail width stays constant, panel slides over the reserved space
    document.documentElement.style.setProperty('--ttwa2-railw', `${globalState.collapsedWidth}px`);
    document.documentElement.style.setProperty('--ttwa2-panelw', `${globalState.expandedWidth}px`);
  }

  function buildRow(rk) {
    ensureRowDefaults(rk);

    const row = document.createElement('div');
    row.className = 'ttwa2-row';
    row.dataset.rk = rk;
    row.innerHTML = `
      <div class="top">
        <div class="name">${humanResourceName(rk)}</div>
        <div class="ttwa2-muted" style="text-align:right;">
          <span class="fill">–</span>
        </div>
      </div>
      <div class="bar"><i></i></div>
      <div class="mini">
        <span class="ttwa2-muted">net</span> <span class="net">–</span>
        <span class="ttwa2-muted">cap</span> <span class="cap">–</span>
      </div>
      <div class="ctrl">
        <div>
          <div class="ttwa2-muted">Mode</div>
          <select class="mode">
            <option value="off">Off</option>
            <option value="on">On</option>
            <option value="balance">Balance</option>
          </select>
        </div>
        <div>
          <div class="ttwa2-muted">Producer</div>
          <select class="producer"></select>
        </div>
        <div>
          <div class="ttwa2-muted">Weight</div>
          <input class="weight" type="number" min="0" max="10" step="0.1"/>
        </div>
        <div>
          <div class="ttwa2-muted">Market</div>
          <div style="display:flex; gap:10px; align-items:center; height:28px;">
            <label class="chk"><input class="mbuy" type="checkbox"/> Buy</label>
            <label class="chk"><input class="msell" type="checkbox"/> Sell</label>
          </div>
        </div>
      </div>
    `;

    const s = rowState[rk];
    const modeEl = row.querySelector('.mode');
    const prodEl = row.querySelector('.producer');
    const weightEl = row.querySelector('.weight');
    const mBuyEl = row.querySelector('.mbuy');
    const mSellEl = row.querySelector('.msell');

    modeEl.value = s.mode;
    weightEl.value = String(s.weight);
    mBuyEl.checked = !!s.mBuy;
    mSellEl.checked = !!s.mSell;

    modeEl.addEventListener('change', () => {
      s.mode = modeEl.value;
      saveAll();
    });
    prodEl.addEventListener('change', () => {
      s.producerKey = prodEl.value || null;
      saveAll();
    });
    weightEl.addEventListener('change', () => {
      s.weight = Math.max(0, Math.min(10, Number(weightEl.value) || 0));
      weightEl.value = String(s.weight);
      saveAll();
    });
    mBuyEl.addEventListener('change', () => {
      s.mBuy = !!mBuyEl.checked;
      saveAll();
    });
    mSellEl.addEventListener('change', () => {
      s.mSell = !!mSellEl.checked;
      saveAll();
    });

    UI.rows.set(rk, row);
    return row;
  }

  function setProducerOptions(rowEl, rk, producers) {
    const sel = rowEl.querySelector('.producer');
    const st = rowState[rk];

    const prev = st.producerKey;
    sel.innerHTML = '';

    if (!producers || producers.length === 0) {
      const opt = document.createElement('option');
      opt.value = '';
      opt.textContent = '— (no worker building)';
      sel.appendChild(opt);
      sel.disabled = true;
      // Mode should be disabled ONLY if there are no worker producers
      rowEl.querySelector('.mode').disabled = true;
      rowEl.querySelector('.weight').disabled = true;
    } else {
      sel.disabled = false;
      rowEl.querySelector('.mode').disabled = false;
      rowEl.querySelector('.weight').disabled = false;

      // "Auto" = first producer (stable sorted)
      const auto = document.createElement('option');
      auto.value = '';
      auto.textContent = 'Auto';
      sel.appendChild(auto);

      for (const b of producers) {
        const opt = document.createElement('option');
        opt.value = b.key;
        const lockTag = b.unlocked ? '' : ' (locked)';
        opt.textContent = `${b.name}${lockTag}`;
        sel.appendChild(opt);
      }

      // restore previous selection if valid
      if (prev && producers.some(p => p.key === prev)) sel.value = prev;
      else sel.value = '';
    }
  }

  // -----------------------
  // Planner
  // -----------------------
  function buildProducerMap(snap) {
    const map = new Map(); // rk -> [{key,name,unlocked,effNeed,count,active}]
    for (const b of snap.buildings) {
      for (const rk of (b.produces || [])) {
        if (!map.has(rk)) map.set(rk, []);
        map.get(rk).push(b);
      }
    }
    // stable sort by name
    for (const [rk, arr] of map.entries()) {
      arr.sort((a, b) => String(a.name).localeCompare(String(b.name)));
    }
    return map;
  }

  function severityBoost(resSt) {
    // boosts weight when net is negative and/or fill is low
    if (!resSt) return 1;
    const cap = resSt.cap;
    const fill = cap > 0 ? (resSt.value / cap) : 0;
    const cons = Math.max(0, resSt.cons);
    const net = resSt.net;
    let sev = 0;
    if (net < 0) {
      const denom = Math.max(1, cons);
      sev += Math.min(1.5, (-net) / denom); // up to +1.5
    }
    if (cap > 0 && fill < 0.15) sev += 0.5;
    if (cap > 0 && fill < 0.05) sev += 0.5;
    return 1 + sev;
  }

  function computeBuildingPlan(snap, producerMap) {
    const workerCap = Math.max(1, snap.workerCap);
    const reservePct = Math.max(0, Math.min(0.30, globalState.workerReservePct));
    const workerBudget = Math.max(0, workerCap * (1 - reservePct));

    // Aggregate by buildingKey, because multiple resources could point to same producer
    const chosen = new Map(); // buildingKey -> {mode, weight, effNeed, count}
    for (const rk of Object.keys(snap.res)) {
      ensureRowDefaults(rk);
      const st = rowState[rk];
      if (st.mode === 'off') continue;

      const producers = producerMap.get(rk) || [];
      if (!producers.length) continue;

      const chosenKey = st.producerKey && producers.some(p => p.key === st.producerKey)
        ? st.producerKey
        : producers[0].key;

      const b = producers.find(p => p.key === chosenKey) || producers[0];
      const w = Math.max(0, Number(st.weight) || 0) * severityBoost(snap.res[rk]);
      if (w <= 0) continue;

      const existing = chosen.get(b.key);
      if (!existing) {
        chosen.set(b.key, {
          key: b.key,
          mode: st.mode,
          weight: w,
          effNeed: Math.max(0.0001, safeNum(b.effNeed) || 1),
          count: safeNum(b.count),
        });
      } else {
        // combine: take "most restrictive" mode (balance beats on)
        existing.mode = (existing.mode === 'balance' || st.mode === 'balance') ? 'balance' : 'on';
        existing.weight += w;
      }
    }

    const items = Array.from(chosen.values());
    const sumW = items.reduce((a, x) => a + x.weight, 0);
    if (sumW <= 0) return {};

    // First pass: compute target counts from workerBudget by weights
    const targets = [];
    for (const it of items) {
      const share = it.weight / sumW;
      const desiredWorkers = workerBudget * share;
      let targetCount = Math.ceil(desiredWorkers / it.effNeed);
      if (it.mode === 'balance') targetCount = Math.min(targetCount, Math.floor(it.count));
      targetCount = Math.max(0, targetCount);
      targets.push({ ...it, targetCount });
    }

    // Overshoot trim to respect workerBudget
    function totalWorkers(ts) {
      return ts.reduce((a, x) => a + x.targetCount * x.effNeed, 0);
    }
    let tw = totalWorkers(targets);
    if (tw > workerBudget && tw > 0) {
      const scale = workerBudget / tw;
      for (const t of targets) {
        const scaled = Math.floor(t.targetCount * scale);
        t.targetCount = Math.max(0, scaled);
      }

      // Distribute leftover workers (greedy) without breaking budget
      let used = totalWorkers(targets);
      let slack = Math.max(0, workerBudget - used);
      // sort by weight desc for slack fill
      targets.sort((a, b) => b.weight - a.weight);
      for (const t of targets) {
        if (slack <= 0) break;
        if (t.mode === 'balance' && t.targetCount >= Math.floor(t.count)) continue;
        const cost = t.effNeed;
        if (cost <= slack) {
          t.targetCount += 1;
          slack -= cost;
        }
      }
    }

    // Build final updates map
    const updates = {};
    for (const t of targets) {
      const pct = (t.targetCount / workerCap) * 100;
      updates[t.key] = {
        autoBuildPercent: Math.max(0, Math.min(100, pct)),
        autoActiveEnabled: true,
        autoBuildEnabled: (t.mode === 'on'),
      };
    }
    return updates;
  }

  function computeMarketPlan(snap) {
    const buys = {};
    const sells = {};
    const horizon = Math.max(5, Math.min(120, globalState.marketHorizonSec));
    const maxBuyFrac = Math.max(0.001, Math.min(0.10, globalState.marketMaxBuyFracPerTick));
    const keepBase = Math.max(0.10, Math.min(0.95, globalState.marketSellKeepBase));
    const keepAgg = Math.max(0.10, Math.min(0.95, globalState.marketSellKeepWhenBuying));

    // Build quick set: are we buying anything at all?
    let anyBuy = false;
    for (const rk of Object.keys(snap.res)) {
      const st = rowState[rk];
      if (st?.mBuy) { anyBuy = true; break; }
    }

    for (const rk of Object.keys(snap.res)) {
      ensureRowDefaults(rk);
      const st = rowState[rk];
      const rs = snap.res[rk];
      if (!rs) continue;

      const cap = rs.cap;
      const val = rs.value;
      const net = rs.net;
      const fill = cap > 0 ? (val / cap) : 0;

      // BUY
      if (st.mBuy) {
        if (cap > 0) {
          const fillTarget = (net < 0) ? 0.12 : 0.06;
          const fillGap = Math.max(0, cap * fillTarget - val);
          const deficitCover = Math.max(0, -net) * horizon;
          let want = fillGap + deficitCover;

          // per-tick cap
          want = Math.min(want, cap * maxBuyFrac);

          // if already decently full, don't buy
          if (fill > fillTarget * 1.2) want = 0;

          if (want > 0) buys[rk] = want;
        } else {
          // no cap: only cover deficit a little
          const want = Math.max(0, -net) * horizon;
          if (want > 0) buys[rk] = want;
        }
      }

      // SELL
      if (st.mSell) {
        if (cap > 0) {
          const keepFrac = anyBuy ? keepAgg : keepBase;
          // if net is negative, don't sell (unless extremely full)
          const effectiveKeep = (net < 0 && fill < 0.98) ? 0.98 : keepFrac;
          const keep = cap * effectiveKeep;
          let want = Math.max(0, val - keep);

          // per-tick cap (sell at most 10% cap per tick to avoid wild swings)
          want = Math.min(want, cap * 0.10);

          if (want > 0) sells[rk] = want;
        } else {
          // no cap: only sell if net positive and value is meaningful
          if (net > 0 && val > 0) sells[rk] = Math.min(val * 0.10, net * horizon);
        }
      }
    }

    return { buys, sells };
  }

  function clampMarketToFunding(snap, plan) {
    // If we can’t get prices, we’ll still prevent buys when funding is already near 0.
    const funding = safeNum(getPageProp('resources')?.colony?.funding?.value);
    const minFunding = Math.max(0, safeNum(globalState.minFunding));

    if (funding <= minFunding + 1) {
      // No money -> no buys. Sells still fine.
      return { ...plan, buys: {} };
    }

    const found = findMarketProject();
    const proj = found?.proj;
    if (!proj) return plan;

    // Estimate net cost if we can discover prices.
    let buyCost = 0;
    let sellRev = 0;
    let haveAnyPrice = false;

    for (const rid of Object.keys(plan.buys || {})) {
      const amt = safeNum(plan.buys[rid]);
      if (amt <= 0) continue;
      const p = priceFromProject(proj, 'buy', rid);
      if (p != null) { haveAnyPrice = true; buyCost += amt * p; }
    }
    for (const rid of Object.keys(plan.sells || {})) {
      const amt = safeNum(plan.sells[rid]);
      if (amt <= 0) continue;
      const p = priceFromProject(proj, 'sell', rid);
      if (p != null) { haveAnyPrice = true; sellRev += amt * p; }
    }

    if (!haveAnyPrice) {
      // price unknown: be conservative with buys if funding is low
      if (funding < 1000) return { ...plan, buys: {} };
      return plan;
    }

    const netCost = buyCost - sellRev;
    const maxSpend = Math.max(0, funding - minFunding);
    if (netCost <= maxSpend) return plan;

    // Scale buys down to fit.
    if (buyCost <= 0) return plan;

    const allowedBuyCost = Math.max(0, maxSpend + sellRev);
    const scale = Math.max(0, Math.min(1, allowedBuyCost / buyCost));

    const newBuys = {};
    for (const rid of Object.keys(plan.buys || {})) {
      const amt = safeNum(plan.buys[rid]);
      const scaled = Math.floor(amt * scale);
      if (scaled > 0) newBuys[rid] = scaled;
    }
    return { ...plan, buys: newBuys };
  }

  // -----------------------
  // Loop + UI sync
  // -----------------------
  let lastAppliedBuildSig = '';
  let lastAppliedMarketSig = '';

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
        } else {
          s += k + ':' + String(v) + ';';
        }
      }
      return s;
    } catch { return String(Math.random()); }
  }

  function tick() {
    try {
      if (!UI.root) buildUI();
      if (!globalState.enabled) return;

      const snap = snapshot();
      if (!snap) return;

      // status
      UI.statusEls.workers.textContent = `${formatNum(snap.workerCap)}`;
      UI.statusEls.free.textContent = `${formatNum(snap.workerFree)}`;
      UI.statusEls.pop.textContent = `${formatNum(snap.pop)}/${formatNum(snap.popCap)}`;
      const funding = safeNum(getPageProp('resources')?.colony?.funding?.value);
      UI.statusEls.funding.textContent = `${formatNum(funding)}`;

      const producerMap = buildProducerMap(snap);

      // ensure rows exist
      const wrap = UI.statusEls.rowsWrap;
      // Keep rows ordered by name
      const rks = Object.keys(snap.res).sort((a, b) => humanResourceName(a).localeCompare(humanResourceName(b)));
      for (const rk of rks) {
        if (!UI.rows.has(rk)) wrap.appendChild(buildRow(rk));
        const rowEl = UI.rows.get(rk);
        const rs = snap.res[rk];

        // fill display
        const cap = rs.cap;
        const val = rs.value;
        const fill = cap > 0 ? (val / cap) : 0;
        rowEl.querySelector('.fill').textContent = cap > 0 ? `${Math.floor(fill * 100)}%` : '—';
        rowEl.querySelector('.cap').textContent = cap > 0 ? formatNum(cap) : '—';
        const netEl = rowEl.querySelector('.net');
        netEl.textContent = (rs.net >= 0 ? '+' : '') + formatNum(rs.net) + '/s';

        // bar
        const bar = rowEl.querySelector('.bar > i');
        bar.style.width = `${Math.max(0, Math.min(100, fill * 100))}%`;
        bar.style.background = rs.net < 0 ? 'rgba(255,120,120,0.9)' : 'rgba(120,220,120,0.9)';

        // producer dropdown
        const producers = (producerMap.get(rk) || []).filter(b => (safeNum(b.effNeed) || 0) > 0);
        setProducerOptions(rowEl, rk, producers);

        // enabled style
        rowEl.classList.toggle('disabled', !rs.unlocked);
      }

      // compute + apply building plan
      const buildUpdates = computeBuildingPlan(snap, producerMap);
      const buildSig = sig(buildUpdates);
      if (buildSig !== lastAppliedBuildSig) {
        applyBuildingUpdates(buildUpdates);
        lastAppliedBuildSig = buildSig;
      }

      // compute + apply market plan
      let marketPlan = computeMarketPlan(snap);
      marketPlan = clampMarketToFunding(snap, marketPlan);

      const marketSig = sig(marketPlan);
      if (marketSig !== lastAppliedMarketSig) {
        applyMarketPlan({ ...marketPlan, ensureRun: true });
        lastAppliedMarketSig = marketSig;
      }
    } catch (e) {
      warn('TTWA tick error', e);
    }
  }

  // -----------------------
  // Start
  // -----------------------
  buildUI();
  setInterval(tick, Math.max(500, globalState.tickMs | 0));
  tick();

})();
