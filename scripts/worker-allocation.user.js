// ==UserScript==
// @name         Terraforming Titans Worker Allocator (Dock + Modes + Market)
// @namespace    tt-scripts
// @version      2.0.0
// @description  Worker allocation with On/Balance/Off modes + Market Buy/Sell + left dock UI.
// @author       you
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // ---------------- Storage ----------------
  const STORE_PREFIX = 'ttwa_v2__';
  const hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

  function getVal(key, def) {
    try {
      if (hasGM) return GM_getValue(STORE_PREFIX + key, def);
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw == null ? def : JSON.parse(raw);
    } catch (e) {
      return def;
    }
  }
  function setVal(key, val) {
    try {
      if (hasGM) return GM_setValue(STORE_PREFIX + key, val);
      localStorage.setItem(STORE_PREFIX + key, JSON.stringify(val));
    } catch (e) {}
  }

  // ---------------- Settings ----------------
  const DEFAULTS = {
    running: false,
    pinnedOpen: false,
    showOnlyUnlocked: true,
    dockCollapsedPx: 44,
    dockExpandedPx: 320,
  };

  const state = (() => {
    const s = getVal('settings', DEFAULTS);
    return Object.assign({}, DEFAULTS, s || {});
  })();

  // Per building settings: { mode:'on'|'balance'|'off', weight:number }
  const bState = getVal('buildings', {});
  // Per resource settings: { buy:boolean, sell:boolean }
  const rState = getVal('resources', {});

  function saveSettings() { setVal('settings', state); }
  function saveBState() { setVal('buildings', bState); }
  function saveRState() { setVal('resources', rState); }

  // ---------------- Helpers ----------------
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
  const toNum = (x, d=0) => (typeof x === 'number' && isFinite(x)) ? x : d;

  function fmtNum(n) {
    n = toNum(n, 0);
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n/1e12).toFixed(2) + 'T';
    if (abs >= 1e9)  return (n/1e9).toFixed(2) + 'B';
    if (abs >= 1e6)  return (n/1e6).toFixed(2) + 'M';
    if (abs >= 1e3)  return (n/1e3).toFixed(2) + 'K';
    return (abs >= 10 ? n.toFixed(0) : n.toFixed(2));
  }

  function resKeyLabel(rk) {
    const parts = String(rk || '').split(':');
    return parts.length >= 2 ? parts[1] : String(rk || '');
  }

  function parseResKey(rk) {
    const [cat, res] = String(rk||'').split(':');
    return { category: cat || 'colony', resource: res || rk };
  }

  // ---------------- Bridge Injection ----------------
  function getApi() {
    return (unsafeWindow && unsafeWindow.__TTWA_V2__) ? unsafeWindow.__TTWA_V2__ : null;
  }

  function injectBridge() {
    if (getApi()) return;

    const code = `
      (function(){
        if (window.__TTWA_V2__) return;

        function safeNumber(x){ return (typeof x==='number' && isFinite(x)) ? x : 0; }

        function getPath(root, path){
          try { var cur=root; for (var i=0;i<path.length;i++){ if(!cur) return undefined; cur=cur[path[i]]; } return cur; }
          catch(e){ return undefined; }
        }

        function effectiveWorkerNeed(b){
          try{
            var base = safeNumber(b.workerNeed || b.workers || b.workerCost || 0);
            if (typeof b.getEffectiveWorkerNeed === 'function') return safeNumber(b.getEffectiveWorkerNeed());
            if (typeof b.getWorkerNeed === 'function') return safeNumber(b.getWorkerNeed());
            // fallback: use field
            var mult = 1;
            if (b.workerNeedMultiplier) mult *= safeNumber(b.workerNeedMultiplier);
            return base * mult;
          }catch(e){ return 0; }
        }

        function computeTargetCount(b, pop, workerCap, collection) {
          try {
            var basis = String((b && b.autoBuildBasis) ? b.autoBuildBasis : 'population');
            if (basis === 'max') return Infinity;
            var base = 0;
            if (b && typeof b.getAutoBuildBase === 'function') {
              base = safeNumber(b.getAutoBuildBase(pop, workerCap, collection));
            } else {
              // best effort: workers basis uses workerCap, population basis uses pop
              base = (basis === 'workers') ? workerCap : pop;
            }
            var pct = safeNumber(b.autoBuildPercent || 0);
            return Math.ceil((pct * safeNumber(base)) / 100);
          } catch(e) { return 0; }
        }

        function collectProducedKeys(b){
          var out=[];
          try{
            var prod = b && (b.production || b.produces || b.output || null);
            if (!prod) return out;
            // if structured like {colony:{electronics:123}}
            for (var cat in prod){
              var obj = prod[cat];
              if (!obj || typeof obj!=='object') continue;
              for (var res in obj){
                out.push(cat+':'+res);
              }
            }
          }catch(e){}
          return out;
        }

        function getMarketKeysFallback(){
          try{
            var pp = (typeof projectParameters!=='undefined') ? projectParameters : null;
            var cfg = pp && pp.galactic_market && pp.galactic_market.attributes && pp.galactic_market.attributes.resourceChoiceGainCost;
            if (!cfg) return [];
            var out=[];
            for (var cat in cfg){
              for (var res in cfg[cat]){
                out.push(cat+':'+res);
              }
            }
            return out;
          }catch(e){ return []; }
        }

        function getMarketInstance(){
          try{
            var pm = (typeof projectManager!=='undefined') ? projectManager : null;
            return pm && pm.projects ? pm.projects.galactic_market : null;
          }catch(e){ return null; }
        }

        window.__TTWA_V2__ = {
          ready: function(){
            try{
              return (typeof buildings!=='undefined') && (typeof resources!=='undefined') && resources && resources.colony && resources.colony.workers;
            }catch(e){ return false; }
          },

          marketInfo: function(){
            try{
              var market = getMarketInstance();
              var keys=[];
              var unlocked=false;
              var has=false;
              if (market){
                has=true;
                unlocked=!!market.unlocked;
                var cfg = market.attributes && market.attributes.resourceChoiceGainCost;
                if (cfg){
                  for (var cat in cfg) for (var res in cfg[cat]) keys.push(cat+':'+res);
                }
              }
              if (!keys.length) keys = getMarketKeysFallback();
              return { ok:true, has:has, unlocked:unlocked, keys:keys };
            }catch(e){ return { ok:false, error:String(e), keys:[] }; }
          },

          snapshot: function(){
            var popV=safeNumber(getPath(resources,['colony','colonists','value']));
            var popC=safeNumber(getPath(resources,['colony','colonists','cap']));
            var workerCap=safeNumber(getPath(resources,['colony','workers','cap']));
            var workerFree=safeNumber(getPath(resources,['colony','workers','value']));

            var out={ pop:popV, popCap:popC, workerCap:workerCap, workerFree:workerFree, buildings:[], res:{} };

            // include market keys even if not produced by worker buildings
            var producedSet={};
            var mi = this.marketInfo();
            if (mi && mi.keys) mi.keys.forEach(k => producedSet[k]=true);

            // add worker-basis buildings
            var collection=(typeof buildings!=='undefined')?buildings:{};
            for (var key in collection){
              var b=collection[key];
              if(!b || b.isHidden) continue;
              var eff = effectiveWorkerNeed(b);
              if(!(eff>0)) continue; // worker-using buildings only

              var prodKeys = collectProducedKeys(b);
              for (var i=0;i<prodKeys.length;i++) producedSet[prodKeys[i]]=true;

              out.buildings.push({
                key:key,
                displayName:(b.displayName || b.name || key),
                category:(b.category||''),
                unlocked:!!b.unlocked,
                count:safeNumber(b.count),
                active:safeNumber(b.active),
                effNeed:eff,
                produces:prodKeys,
                autoBuildEnabled:!!b.autoBuildEnabled,
                autoActiveEnabled:!!b.autoActiveEnabled,
                autoBuildBasis:String(b.autoBuildBasis || 'population'),
                autoBuildPercent:safeNumber(b.autoBuildPercent),
                targetCount:computeTargetCount(b, popV, workerCap, collection)
              });
            }

            // fill resource states
            for (var rk in producedSet){
              if(!producedSet[rk]) continue;
              var parts=rk.split(':');
              var cat=parts[0], res=parts[1];
              var rObj = resources && resources[cat] ? resources[cat][res] : null;
              if(!rObj) continue;
              out.res[rk] = {
                value: safeNumber(rObj.value),
                cap: safeNumber(rObj.cap),
                net: safeNumber(rObj.net),
                prod: safeNumber(rObj.production),
                cons: safeNumber(rObj.consumption)
              };
            }

            return out;
          },

          applyBuildings: function(updates){
            try{
              var collection=(typeof buildings!=='undefined')?buildings:{};
              for (var key in updates){
                var u=updates[key];
                var b=collection[key];
                if(!b || !u) continue;
                if (u.hasOwnProperty('autoBuildBasis')) b.autoBuildBasis = String(u.autoBuildBasis);
                if (u.hasOwnProperty('autoBuildEnabled')) b.autoBuildEnabled = !!u.autoBuildEnabled;
                if (u.hasOwnProperty('autoActiveEnabled')) b.autoActiveEnabled = !!u.autoActiveEnabled;
                if (u.hasOwnProperty('autoBuildPercent')){
                  var v=Number(u.autoBuildPercent);
                  if (isFinite(v)) b.autoBuildPercent = v;
                }
              }
              return { ok:true };
            }catch(e){ return { ok:false, error:String(e) }; }
          },

          applyMarket: function(buys, sells){
            try{
              var pm = (typeof projectManager!=='undefined') ? projectManager : null;
              var market = getMarketInstance();
              if (!pm || !market) return { ok:false, error:'Market not available' };

              // normalize entries: {category,resource,quantity}
              function norm(arr){
                var out=[];
                (arr||[]).forEach(function(x){
                  if(!x) return;
                  var cat=String(x.category||'colony');
                  var res=String(x.resource||'');
                  var qty=Math.max(0, Math.floor(Number(x.quantity)||0));
                  if(!res || qty<=0) return;
                  out.push({category:cat, resource:res, quantity:qty});
                });
                return out;
              }

              market.buySelections = norm(buys);
              market.sellSelections = norm(sells);

              market.autoStart = true;
              market.isPaused = false;

              if (!market.isActive) {
                // start only if there are selections (canStart depends on that)
                if (market.buySelections.length || market.sellSelections.length) {
                  pm.startProject && pm.startProject('galactic_market');
                }
              }

              return { ok:true };
            }catch(e){ return { ok:false, error:String(e) }; }
          }
        };
      })();
    `;

    const s = document.createElement('script');
    s.textContent = code;
    document.documentElement.appendChild(s);
    s.remove();
  }

  // ---------------- UI Dock ----------------
  const ui = {};
  const rt = { hovered:false, lastKeySig:'' };

  function addStyle(css) {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function el(tag, attrs={}, kids=[]) {
    const e = document.createElement(tag);
    for (const k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (kids||[]).forEach(c => e.appendChild(c));
    return e;
  }

  function buildUI() {
    addStyle(`
      :root {
        --ttwa-collapsed: ${state.dockCollapsedPx}px;
        --ttwa-expanded: ${state.dockExpandedPx}px;
        --ttwa-dockw: var(--ttwa-collapsed);
      }

      #ttwa-root {
        position: fixed;
        left: 0; top: 0;
        height: 100vh;
        width: var(--ttwa-dockw);
        z-index: 99999;
        font-family: system-ui, sans-serif;
        color: #e9eef5;
        pointer-events: auto;
      }

      #ttwa-panel {
        height: 100%;
        background: rgba(18, 20, 26, 0.96);
        border-right: 1px solid rgba(255,255,255,0.08);
        box-shadow: 2px 0 14px rgba(0,0,0,0.35);
        display: flex;
        flex-direction: column;
        overflow: hidden;
      }

      #ttwa-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        background: rgba(30,33,40,0.9);
      }

      #ttwa-title {
        font-weight: 800;
        font-size: 12px;
        letter-spacing: 0.2px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        flex: 1;
      }

      .ttwa-btn {
        appearance: none;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(255,255,255,0.06);
        color: #e9eef5;
        border-radius: 8px;
        padding: 6px 8px;
        font-size: 12px;
        cursor: pointer;
      }
      .ttwa-btn.primary {
        background: rgba(66, 165, 245, 0.25);
        border-color: rgba(66, 165, 245, 0.55);
      }

      #ttwa-body {
        flex: 1;
        overflow: auto;
        padding: 8px;
        display: flex;
        flex-direction: column;
        gap: 10px;
      }

      .ttwa-card {
        background: rgba(255,255,255,0.05);
        border: 1px solid rgba(255,255,255,0.08);
        border-radius: 10px;
        padding: 8px;
      }

      .ttwa-row {
        display: grid;
        grid-template-columns: 1fr auto;
        gap: 8px;
        align-items: center;
      }

      .ttwa-mini { font-size: 11px; opacity: 0.85; }
      .ttwa-muted { opacity: 0.65; }

      .ttwa-resrow {
        border-top: 1px solid rgba(255,255,255,0.06);
        padding-top: 8px;
        margin-top: 8px;
      }

      .ttwa-resname {
        font-weight: 800;
        font-size: 12px;
      }

      .ttwa-sub {
        font-size: 11px;
        opacity: 0.7;
      }

      .ttwa-controls {
        display: grid;
        grid-template-columns: 1fr 68px;
        gap: 6px;
        margin-top: 6px;
      }

      select.ttwa-mode, input.ttwa-weight {
        width: 100%;
        box-sizing: border-box;
        padding: 5px 6px;
        border-radius: 8px;
        border: 1px solid rgba(255,255,255,0.12);
        background: rgba(0,0,0,0.25);
        color: #e9eef5;
        font-size: 12px;
      }

      .ttwa-toggles {
        display: flex;
        gap: 10px;
        margin-top: 6px;
        flex-wrap: wrap;
        font-size: 11px;
        opacity: 0.9;
      }
      .ttwa-toggles label { cursor:pointer; }

      .ttwa-bar {
        position: relative;
        height: 14px;
        border-radius: 8px;
        background: rgba(255,255,255,0.08);
        overflow: hidden;
        margin-top: 6px;
      }
      .ttwa-barfill {
        position: absolute;
        left:0; top:0; bottom:0;
        width:0%;
        background: rgba(76, 175, 80, 0.5);
      }
      .ttwa-bartext {
        position: relative;
        z-index: 1;
        font-size: 11px;
        padding-left: 6px;
        line-height: 14px;
        white-space: nowrap;
      }

      /* Dock behavior: shift game instead of overlay */
      #game-container {
        margin-left: var(--ttwa-dockw) !important;
        width: calc(100vw - var(--ttwa-dockw)) !important;
        max-width: calc(100vw - var(--ttwa-dockw)) !important;
      }
      body { overflow-x: hidden !important; }
    `);

    ui.root = el('div', { id:'ttwa-root' });
    ui.panel = el('div', { id:'ttwa-panel' });
    ui.header = el('div', { id:'ttwa-header' });
    ui.title = el('div', { id:'ttwa-title', text:'TTWA' });

    ui.runBtn = el('button', { class:'ttwa-btn primary', text: state.running ? 'Stop' : 'Start' });
    ui.pinBtn = el('button', { class:'ttwa-btn', text: state.pinnedOpen ? 'Unpin' : 'Pin' });

    ui.header.append(ui.title, ui.runBtn, ui.pinBtn);

    ui.body = el('div', { id:'ttwa-body' });

    ui.statusCard = el('div', { class:'ttwa-card' });
    ui.listCard = el('div', { class:'ttwa-card' });

    ui.body.append(ui.statusCard, ui.listCard);

    ui.panel.append(ui.header, ui.body);
    ui.root.append(ui.panel);
    document.body.appendChild(ui.root);

    ui.root.addEventListener('mouseenter', () => { rt.hovered=true; updateDockWidth(); });
    ui.root.addEventListener('mouseleave', () => { rt.hovered=false; updateDockWidth(); });

    ui.runBtn.addEventListener('click', () => {
      state.running = !state.running;
      ui.runBtn.textContent = state.running ? 'Stop' : 'Start';
      saveSettings();
    });

    ui.pinBtn.addEventListener('click', () => {
      state.pinnedOpen = !state.pinnedOpen;
      ui.pinBtn.textContent = state.pinnedOpen ? 'Unpin' : 'Pin';
      updateDockWidth();
      saveSettings();
    });

    updateDockWidth();
  }

  function updateDockWidth() {
    const expanded = state.pinnedOpen || rt.hovered;
    const w = expanded ? state.dockExpandedPx : state.dockCollapsedPx;
    document.documentElement.style.setProperty('--ttwa-dockw', w + 'px');
    ui.title.textContent = expanded ? 'TT Worker Allocator' : 'TTWA';
  }

  // ---------------- Allocation Logic ----------------
  function normalizeBuildingState(bkey) {
    if (!bState[bkey]) bState[bkey] = {};
    const s = bState[bkey];
    if (!s.mode) {
      // migration from old enabled boolean if present
      if (s.enabled === false) s.mode = 'off';
      else s.mode = 'on';
    }
    if (typeof s.weight !== 'number' || !isFinite(s.weight)) s.weight = 0;
    // cleanup legacy
    if ('enabled' in s) delete s.enabled;
  }

  function normalizeResourceState(rk) {
    if (!rState[rk]) rState[rk] = {};
    if (typeof rState[rk].buy !== 'boolean') rState[rk].buy = false;
    if (typeof rState[rk].sell !== 'boolean') rState[rk].sell = false;
  }

  function pickPrimaryResourceKey(b) {
    // prefer first produced key, if any
    const pr = (b && b.produces) ? b.produces : [];
    return pr && pr.length ? pr[0] : '';
  }

  function computePlan(snapshot, marketKeysSet) {
    const workerCap = toNum(snapshot.workerCap, 0);
    const allocBuildings = snapshot.buildings.slice();

    // reserve “off” buildings as fixed usage (based on expected active)
    let offWorkers = 0;
    const controlled = [];

    for (const b of allocBuildings) {
      normalizeBuildingState(b.key);
      const bs = bState[b.key];
      if (state.showOnlyUnlocked && !b.unlocked) continue;

      if (bs.mode === 'off') {
        const expectedActive = b.autoActiveEnabled ? Math.min(toNum(b.targetCount,0), toNum(b.count,0)) : toNum(b.active,0);
        offWorkers += expectedActive * toNum(b.effNeed, 0);
      } else {
        controlled.push(b);
      }
    }

    const remainder = Math.max(0, workerCap - offWorkers);

    // weight distribution
    let sumW = 0;
    const entries = [];
    for (const b of controlled) {
      const bs = bState[b.key];
      const w = Math.max(0, toNum(bs.weight, 0));
      if (w <= 0) continue;
      entries.push({ b, w, mode: bs.mode });
      sumW += w;
    }

    const targetCountByKey = {};
    const percentByKey = {};

    if (sumW > 0 && remainder > 0) {
      for (const e of entries) {
        const b = e.b;
        const eff = Math.max(1e-9, toNum(b.effNeed, 0));
        const shareWorkers = remainder * (e.w / sumW);
        let tgtCount = Math.floor(shareWorkers / eff);
        if (e.mode === 'balance') {
          tgtCount = Math.min(tgtCount, Math.floor(toNum(b.count, 0)));
        }
        targetCountByKey[b.key] = tgtCount;
        percentByKey[b.key] = (workerCap > 0) ? (tgtCount * 100 / workerCap) : 0;
      }
    }

    return { workerCap, remainder, offWorkers, allocBuildings, controlled, targetCountByKey, percentByKey };
  }

  function applyPlan(plan) {
    if (!state.running) return;
    const api = getApi();
    if (!api) return;

    const updates = {};
    for (const b of plan.controlled) {
      normalizeBuildingState(b.key);
      const bs = bState[b.key];
      if (bs.mode === 'off') continue;

      const pct = toNum(plan.percentByKey[b.key], 0);

      updates[b.key] = {
        autoBuildBasis: 'workers',
        autoBuildPercent: pct,
        autoActiveEnabled: true,
        autoBuildEnabled: (bs.mode === 'on')
      };
    }

    const keys = Object.keys(updates);
    if (!keys.length) return;

    const res = api.applyBuildings(updates);
    if (res && res.ok === false) {
      // fail-safe: stop running if apply fails
      state.running = false;
      saveSettings();
      ui.runBtn.textContent = 'Start';
    }
  }

  // ---------------- Market Logic ----------------
  function applyMarket(snapshot, marketKeys) {
    if (!state.running) return;
    const api = getApi();
    if (!api) return;

    // Build buy/sell selection arrays (rates per second)
    const buyMap = new Map();
    const sellMap = new Map();

    for (const rk of marketKeys) {
      normalizeResourceState(rk);
      const cfg = rState[rk];
      if (!cfg.buy && !cfg.sell) continue;

      const st = snapshot.res ? snapshot.res[rk] : null;
      if (!st) continue;

      const cap = toNum(st.cap, 0);
      const val = toNum(st.value, 0);
      const net = toNum(st.net, 0);
      const fill = (cap > 0) ? (val / cap) : 0;

      let buyRate = 0;
      let sellRate = 0;

      if (cfg.buy) {
        // buy if net negative or buffer low (<30%)
        const deficit = Math.max(0, -net);
        const bufferTarget = 0.30;
        const refill = (cap > 0 && fill < bufferTarget) ? ((bufferTarget - fill) * cap / 180) : 0; // refill in ~3 min
        buyRate = deficit + refill;
      }

      if (cfg.sell) {
        // keep under 90%
        const sellTarget = 0.90;
        const excess = (cap > 0 && fill > sellTarget) ? ((fill - sellTarget) * cap) : 0;
        const bleed = (excess > 0) ? (excess / 180) : 0; // drain in ~3 min
        sellRate = Math.max(0, net) + bleed;
      }

      // avoid simultaneous buy+sell insanity (prefer buy when starving)
      if (buyRate > 0 && sellRate > 0) {
        if (net < 0 || fill < 0.6) sellRate = 0;
        else buyRate = 0;
      }

      const pr = parseResKey(rk);
      if (buyRate > 0) buyMap.set(rk, { category: pr.category, resource: pr.resource, quantity: Math.floor(buyRate) });
      if (sellRate > 0) sellMap.set(rk, { category: pr.category, resource: pr.resource, quantity: Math.floor(sellRate) });
    }

    const buys = Array.from(buyMap.values()).filter(x => x.quantity > 0);
    const sells = Array.from(sellMap.values()).filter(x => x.quantity > 0);

    api.applyMarket(buys, sells);
  }

  // ---------------- UI Row Rendering ----------------
  function ensureRows(snapshot, marketKeys) {
    const alloc = snapshot.buildings || [];

    // Map resource -> building (first match)
    const resToBuilding = {};
    const miscBuildings = [];

    for (const b of alloc) {
      normalizeBuildingState(b.key);
      if (state.showOnlyUnlocked && !b.unlocked) continue;

      const rk = pickPrimaryResourceKey(b);
      if (rk) {
        if (!resToBuilding[rk]) resToBuilding[rk] = b;
      } else {
        miscBuildings.push(b);
      }
    }

    // Include market resources as main list
    const allResKeys = Array.from(new Set([...(marketKeys||[]), ...Object.keys(resToBuilding)]));
    allResKeys.sort();

    const sig = JSON.stringify({ res: allResKeys, misc: miscBuildings.map(b=>b.key).sort() });
    if (sig === rt.lastKeySig) return;
    rt.lastKeySig = sig;

    ui.listCard.innerHTML = '';

    const title = el('div', { class:'ttwa-mini ttwa-muted', text:'Resources (modes + market)' });
    ui.listCard.appendChild(title);

    allResKeys.forEach(rk => {
      normalizeResourceState(rk);
      const b = resToBuilding[rk] || null;
      const row = el('div', { class:'ttwa-resrow', 'data-rk': rk, 'data-bkey': b ? b.key : '' });

      const top = el('div', { class:'ttwa-row' }, [
        el('div', { class:'ttwa-resname', text: resKeyLabel(rk) }),
        el('div', { class:'ttwa-mini ttwa-muted', text: b ? b.displayName : 'Market only' })
      ]);

      row.appendChild(top);

      const st = snapshot.res ? snapshot.res[rk] : null;
      const cap = st ? toNum(st.cap,0) : 0;
      const val = st ? toNum(st.value,0) : 0;
      const net = st ? toNum(st.net,0) : 0;
      const fill = cap > 0 ? clamp(val/cap, 0, 1) : 0;

      const bar = el('div', { class:'ttwa-bar' }, [
        el('div', { class:'ttwa-barfill' }),
        el('div', { class:'ttwa-bartext', text: cap>0 ? `${(fill*100).toFixed(1)}% · net ${fmtNum(net)}/s` : `net ${fmtNum(net)}/s` })
      ]);
      row.appendChild(bar);

      const controls = el('div', { class:'ttwa-controls' });
      const modeSel = el('select', { class:'ttwa-mode' });
      ['on','balance','off'].forEach(m => {
        const opt = el('option', { value:m, text: m[0].toUpperCase()+m.slice(1) });
        modeSel.appendChild(opt);
      });

      const weightInp = el('input', { class:'ttwa-weight', type:'number', step:'0.1', min:'0', value:'0' });

      if (!b) {
        modeSel.disabled = true;
        weightInp.disabled = true;
      } else {
        const bs = bState[b.key];
        modeSel.value = bs.mode || 'on';
        weightInp.value = String(toNum(bs.weight,0));
      }

      controls.append(modeSel, weightInp);
      row.appendChild(controls);

      const toggles = el('div', { class:'ttwa-toggles' });

      const buyCb = el('input', { type:'checkbox' });
      buyCb.checked = !!rState[rk].buy;

      const sellCb = el('input', { type:'checkbox' });
      sellCb.checked = !!rState[rk].sell;

      toggles.append(
        el('label', {}, [buyCb, document.createTextNode(' Market Buy')]),
        el('label', {}, [sellCb, document.createTextNode(' Market Sell')])
      );

      row.appendChild(toggles);

      modeSel.addEventListener('change', () => {
        if (!b) return;
        normalizeBuildingState(b.key);
        bState[b.key].mode = modeSel.value;
        saveBState();
      });

      weightInp.addEventListener('input', () => {
        if (!b) return;
        normalizeBuildingState(b.key);
        bState[b.key].weight = Math.max(0, Number(weightInp.value)||0);
        saveBState();
      });

      buyCb.addEventListener('change', () => {
        normalizeResourceState(rk);
        rState[rk].buy = buyCb.checked;
        saveRState();
      });

      sellCb.addEventListener('change', () => {
        normalizeResourceState(rk);
        rState[rk].sell = sellCb.checked;
        saveRState();
      });

      ui.listCard.appendChild(row);
    });

    if (miscBuildings.length) {
      ui.listCard.appendChild(el('div', { class:'ttwa-mini ttwa-muted', text:'Other worker buildings (no resource output detected)' }));

      miscBuildings.forEach(b => {
        normalizeBuildingState(b.key);
        const row = el('div', { class:'ttwa-resrow', 'data-bkey': b.key });

        row.appendChild(el('div', { class:'ttwa-resname', text: b.displayName }));
        row.appendChild(el('div', { class:'ttwa-sub', text: `key: ${b.key}` }));

        const controls = el('div', { class:'ttwa-controls' });
        const modeSel = el('select', { class:'ttwa-mode' });
        ['on','balance','off'].forEach(m => modeSel.appendChild(el('option', { value:m, text:m[0].toUpperCase()+m.slice(1) })));

        const weightInp = el('input', { class:'ttwa-weight', type:'number', step:'0.1', min:'0' });

        modeSel.value = bState[b.key].mode || 'on';
        weightInp.value = String(toNum(bState[b.key].weight,0));

        modeSel.addEventListener('change', () => { bState[b.key].mode = modeSel.value; saveBState(); });
        weightInp.addEventListener('input', () => { bState[b.key].weight = Math.max(0, Number(weightInp.value)||0); saveBState(); });

        controls.append(modeSel, weightInp);
        row.appendChild(controls);

        ui.listCard.appendChild(row);
      });
    }
  }

  function renderStatus(snapshot, plan, marketInfo) {
    const workerCap = toNum(snapshot.workerCap, 0);
    const free = toNum(snapshot.workerFree, 0);

    const mi = marketInfo && marketInfo.ok ? marketInfo : null;
    const marketText = mi
      ? (mi.unlocked ? `Market: unlocked (${(mi.keys||[]).length} res)` : `Market: locked (${(mi.keys||[]).length} res known)`)
      : 'Market: n/a';

    ui.statusCard.innerHTML = `
      <div class="ttwa-resname">Status</div>
      <div class="ttwa-mini">Workers cap: <b>${fmtNum(workerCap)}</b> · free: <b>${fmtNum(free)}</b></div>
      <div class="ttwa-mini ttwa-muted">Off-reserved: ${fmtNum(plan.offWorkers)} · remainder: ${fmtNum(plan.remainder)}</div>
      <div class="ttwa-mini ttwa-muted">${marketText}</div>
    `;
  }

  // ---------------- Main Loop ----------------
  function tick() {
    injectBridge();
    const api = getApi();
    if (!api || !api.ready || !api.ready()) return;

    const marketInfo = api.marketInfo();
    const marketKeys = (marketInfo && marketInfo.keys) ? marketInfo.keys : [];
    const marketSet = new Set(marketKeys);

    const snapshot = api.snapshot();
    const plan = computePlan(snapshot, marketSet);

    ensureRows(snapshot, marketKeys);
    renderStatus(snapshot, plan, marketInfo);

    applyPlan(plan);
    applyMarket(snapshot, marketKeys);

    updateDockWidth();
  }

  // ---------------- Boot ----------------
  buildUI();
  injectBridge();
  setInterval(tick, 500);
  tick();

})();
