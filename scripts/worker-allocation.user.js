// ==UserScript==
// @name         Terraforming Titans Worker Allocator (Resources + Market + Left Dock)
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      2.0.1
// @description  Resource-centric worker allocation + smarter Galactic Market buy/sell + left hover dock that resizes the game (no overlay covering).
// @author       kov27 (modified by ChatGPT)
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

  // -------------------- Shared Runtime (compatible with kov27 scripts) --------------------
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const TT = (() => {
    const LS = (() => { try { return W.localStorage; } catch { return null; } })();
    const shared = W.__TT_SHARED__ || (W.__TT_SHARED__ = {
      masterEnabled: true,
      pauseUntil: 0,
      locks: {},
      lastAction: '',
      lastError: '',
    });
    function now() { return Date.now(); }
    function isPaused() { return now() < (shared.pauseUntil || 0); }
    function setPaused(ms, reason) { shared.pauseUntil = now() + Math.max(0, ms|0); shared.lastAction = `paused:${reason||''}`; }
    function setError(msg) { shared.lastError = String(msg||''); }
    function isMasterEnabled() {
      if (!LS) return shared.masterEnabled !== false;
      const v = LS.getItem('tt.masterEnabled');
      if (v === null) return shared.masterEnabled !== false;
      return v !== '0';
    }
    return { shared, isPaused, setPaused, setError, isMasterEnabled };
  })();

  // -------------------- Storage --------------------
  const STORE_KEY = 'ttwa_v2__';
  const hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

  function getVal(key, def) {
    try {
      if (hasGM) return GM_getValue(STORE_KEY + key, def);
      const raw = localStorage.getItem(STORE_KEY + key);
      return (raw == null) ? def : JSON.parse(raw);
    } catch { return def; }
  }
  function setVal(key, val) {
    try {
      if (hasGM) return GM_setValue(STORE_KEY + key, val);
      localStorage.setItem(STORE_KEY + key, JSON.stringify(val));
    } catch {}
  }

  // -------------------- Utils --------------------
  const SUFFIX_FMT = [[1e24,'Y'],[1e21,'Z'],[1e18,'E'],[1e15,'P'],[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']];
  function fmtNum(x) {
    if (!Number.isFinite(x)) return String(x);
    const ax = Math.abs(x);
    for (const [v,s] of SUFFIX_FMT) {
      if (ax >= v) {
        const d = (ax >= v * 100) ? 0 : (ax >= v * 10) ? 1 : 2;
        return (x / v).toFixed(d) + s;
      }
    }
    if (ax >= 100) return x.toFixed(0);
    if (ax >= 10) return x.toFixed(1);
    if (ax >= 1) return x.toFixed(2);
    if (ax === 0) return '0';
    return x.toExponential(3);
  }
  function clamp(x, a, b) {
    const n = Number(x);
    if (!Number.isFinite(n)) return a;
    return Math.max(a, Math.min(b, n));
  }
  function toNum(x, d=0) {
    const n = Number(x);
    return Number.isFinite(n) ? n : d;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  }
  function rkParts(rk){ const i=rk.indexOf(':'); return i>0 ? [rk.slice(0,i), rk.slice(i+1)] : ['','']; }

  // -------------------- Defaults --------------------
  const DEFAULTS = {
    running: true,
    pinned: false,
    collapsedWidth: 26,
    expandedWidth: 320,
    tickMs: 750,

    // Worker allocation
    reserveWorkersPct: 0, // % of workerCap to keep free (0-50)
    defaultWeight: 1,

    // Market tuning
    marketEnabled: true,
    fundingBufferSeconds: 15,   // keep enough funds for N seconds of market spending
    sellDrainHorizonSeconds: 120, // how quickly we're allowed to drain "excess" stock via selling
    sellMinFill: 0.35,          // never sell below this fill if cap exists (unless cap==0)
    sellHighFill: 0.88,         // start bleeding above this
    sellTargetFill: 0.75,       // aim to bleed down toward this
    buyTargetFillOnShortage: 0.35,
    buyRefillSeconds: 20,
    buyBufferSeconds: 30,
    buyMaxFill: 0.60,           // buffer fill cap (avoid buying to 99% just for buffer)
  };

  const settings = Object.assign({}, DEFAULTS, getVal('settings', {}));

  // Resource config is stored per-planet (planet key) to avoid cross-planet confusion.
  // shape: { [planetKey]: { [rk]: { mode, weight, marketBuy, marketSell, producerKey } } }
  const cfgByPlanet = getVal('cfgByPlanet', {});
  function saveSettings(){ setVal('settings', settings); }
  function saveCfg(){ setVal('cfgByPlanet', cfgByPlanet); }

  function getPlanetCfg(planetKey){
    const pk = planetKey || 'default';
    if (!cfgByPlanet[pk]) cfgByPlanet[pk] = {};
    return cfgByPlanet[pk];
  }

  // -------------------- Page-context Bridge --------------------
  const BRIDGE_NAME = '__TTWA_V2__';

  function injectBridge() {
    if (W[BRIDGE_NAME]) return;

    const code = `
      (function(){
        if (window.${BRIDGE_NAME}) return;

        function safeNumber(x){ return (typeof x==='number' && isFinite(x)) ? x : 0; }
        function getPath(root, path){ try{ var cur=root; for(var i=0;i<path.length;i++){ if(!cur) return undefined; cur=cur[path[i]]; } return cur; }catch(e){ return undefined; } }

        function effectiveWorkerNeed(b){
          try{
            var base=0;
            if(b && typeof b.getTotalWorkerNeed==='function') base=safeNumber(b.getTotalWorkerNeed());
            else base=safeNumber(b ? b.requiresWorker : 0);
            var mult=1;
            if(b && typeof b.getEffectiveWorkerMultiplier==='function') mult=safeNumber(b.getEffectiveWorkerMultiplier());
            if(!mult) mult=1;
            return base*mult;
          }catch(e){ return 0; }
        }

        function isNonZeroConsumptionEntry(v){
          if(v==null) return false;
          if(typeof v==='number') return v!==0;
          if(typeof v==='object'){
            if(typeof v.amount==='number') return v.amount!==0;
            for(var k in v){ if(typeof v[k]==='number' && v[k]!==0) return true; }
          }
          return false;
        }

        function collectProducedKeys(b){
          var out=[];
          var prod=b&&b.production?b.production:{};
          for(var cat in prod){
            if(cat!=='colony' && cat!=='special') continue;
            var obj=prod[cat];
            if(!obj||typeof obj!=='object') continue;
            for(var res in obj){ out.push(cat+':'+res); }
          }
          return out;
        }

        function hasExternalInputs(b){
          var cons=b&&b.consumption?b.consumption:{};
          for(var cat in cons){
            if(cat==='colony'||cat==='special') continue;
            var obj=cons[cat];
            if(!obj||typeof obj!=='object') continue;
            for(var res in obj){
              if(isNonZeroConsumptionEntry(obj[res])) return true;
            }
          }
          return false;
        }

        function getAutobuildAvg(cat,res){
          try{
            if(typeof autobuildCostTracker==='undefined' || !autobuildCostTracker) return 0;
            if(cat!=='colony') return 0;
            if(typeof autobuildCostTracker.getAverageCost!=='function') return 0;
            return safeNumber(autobuildCostTracker.getAverageCost(cat,res));
          }catch(e){ return 0; }
        }

        function getResState(cat,res){
          try{
            var r=resources&&resources[cat]?resources[cat][res]:null;
            if(!r) return null;
            var prod=safeNumber(r.productionRate);
            var cons=safeNumber(r.consumptionRate);
            var ab=getAutobuildAvg(cat,res);
            var net=(cat==='colony') ? (prod-cons-ab) : (prod-cons);
            return {
              category:cat,
              name:res,
              displayName:(r.displayName||res),
              value:safeNumber(r.value),
              cap:safeNumber(r.cap),
              reserved:safeNumber(r.reserved),
              prod:prod,
              cons:cons,
              autobuildAvg:ab,
              net:net,
              overflow:safeNumber(r.overflowRate),
              unlocked:!!r.unlocked,
              autobuildShortage:!!r.autobuildShortage,
              automationLimited:!!r.automationLimited
            };
          }catch(e){ return null; }
        }

        function getMarketKeys(){
          try{
            var p = (typeof projectParameters!=='undefined' && projectParameters && projectParameters.galactic_market) ? projectParameters.galactic_market : null;
            if(!p || !p.attributes || !p.attributes.resourceChoiceGainCost) return [];
            var out=[];
            var rc = p.attributes.resourceChoiceGainCost;
            for(var cat in rc){
              var obj=rc[cat];
              if(!obj||typeof obj!=='object') continue;
              for(var res in obj){ out.push(cat+':'+res); }
            }
            return out;
          }catch(e){ return []; }
        }

        function getPlanetKey(){
          try{
            var sm = (typeof spaceManager!=='undefined' && spaceManager) ? spaceManager : (globalThis.spaceManager||null);
            if(sm && typeof sm.getCurrentPlanetKey==='function') return String(sm.getCurrentPlanetKey()||'');
            if(sm && sm.currentPlanetKey) return String(sm.currentPlanetKey||'');
            var cp = (typeof currentPlanetParameters!=='undefined' && currentPlanetParameters) ? currentPlanetParameters : (globalThis.currentPlanetParameters||null);
            if(cp && (cp.key||cp.planetKey)) return String(cp.key||cp.planetKey||'');
          }catch(e){}
          return '';
        }

        function getMarket(){
          try{
            var pm = (typeof projectManager!=='undefined' && projectManager) ? projectManager : (globalThis.projectManager||null);
            if(pm && pm.projects && pm.projects.galactic_market) return pm.projects.galactic_market;
          }catch(e){}
          return null;
        }

        window.${BRIDGE_NAME} = {
          ready:function(){
            try{ return (typeof buildings!=='undefined')&&(typeof resources!=='undefined')&&resources&&resources.colony&&resources.colony.workers; }catch(e){ return false; }
          },

          snapshot:function(){
            var popV=safeNumber(getPath(resources,['colony','colonists','value']));
            var popC=safeNumber(getPath(resources,['colony','colonists','cap']));
            var workerCap=safeNumber(getPath(resources,['colony','workers','cap']));
            var workerFree=safeNumber(getPath(resources,['colony','workers','value']));
            var fundV=safeNumber(getPath(resources,['colony','funding','value']));
            var out={
              planetKey:getPlanetKey(),
              pop:popV, popCap:popC,
              workerCap:workerCap, workerFree:workerFree,
              funding:fundV,
              buildings:[],
              res:{},
              market:{ unlocked:false, active:false, autoStart:false, keys:getMarketKeys() }
            };

            var producedSet={};
            // Always include market keys + funding for UI/logic
            var mk = out.market.keys;
            for(var i=0;i<mk.length;i++){ producedSet[mk[i]]=true; }
            producedSet['colony:funding']=true;

            var collection=(typeof buildings!=='undefined')?buildings:{};
            for(var key in collection){
              var b=collection[key];
              if(!b) continue;
              var eff=effectiveWorkerNeed(b);
              if(!(eff>0)) continue;
              var prodKeys=collectProducedKeys(b);
              for(var j=0;j<prodKeys.length;j++){ producedSet[prodKeys[j]]=true; }

              out.buildings.push({
                key:key,
                displayName:(b.displayName||b.name||key),
                category:(b.category||''),
                unlocked:!!b.unlocked,
                effNeed:eff,
                count:safeNumber(b.count),
                active:safeNumber(b.active),
                autoBuildEnabled:!!b.autoBuildEnabled,
                autoBuildBasis:String(b.autoBuildBasis||'population'),
                autoBuildPercent:safeNumber(b.autoBuildPercent),
                autoActiveEnabled:!!b.autoActiveEnabled,
                produces:prodKeys,
                hasExternalInputs:hasExternalInputs(b)
              });
            }

            for(var rk in producedSet){
              if(!producedSet[rk]) continue;
              var parts=rk.split(':');
              var st=getResState(parts[0],parts[1]);
              if(st) out.res[rk]=st;
            }

            var m = getMarket();
            if(m){
              out.market.unlocked = !!m.unlocked;
              out.market.active = !!m.isActive;
              out.market.autoStart = !!m.autoStart;
            }

            out.buildings.sort(function(a,b){
              var c=String(a.category||'').localeCompare(String(b.category||''));
              if(c) return c;
              return String(a.displayName||'').localeCompare(String(b.displayName||''));
            });

            return out;
          },

          applyBuildings:function(updates){
            try{
              var collection=(typeof buildings!=='undefined')?buildings:{};
              for(var key in updates){
                var u=updates[key];
                var b=collection[key];
                if(!b||!u) continue;

                if(u.hasOwnProperty('autoBuildBasis')) b.autoBuildBasis = String(u.autoBuildBasis||'workers');
                if(u.hasOwnProperty('autoBuildPercent')){
                  var v=Number(u.autoBuildPercent);
                  if(isFinite(v)) b.autoBuildPercent = v;
                }
                if(u.hasOwnProperty('autoBuildEnabled')) b.autoBuildEnabled = !!u.autoBuildEnabled;
                if(u.hasOwnProperty('autoActiveEnabled')) b.autoActiveEnabled = !!u.autoActiveEnabled;
              }
              return {ok:true};
            }catch(e){ return {ok:false,error:String(e)}; }
          },

          getMarketQuotes:function(req){
            try{
              var m=getMarket();
              if(!m || typeof m.getBuyPrice!=='function' || typeof m.getSellPrice!=='function') return {ok:false, error:'market unavailable'};
              var out={ ok:true, quotes:{} };
              var arr = (req && req.entries && Array.isArray(req.entries)) ? req.entries : [];
              for(var i=0;i<arr.length;i++){
                var e=arr[i]||{};
                var cat=String(e.category||'');
                var res=String(e.resource||'');
                var qty=safeNumber(e.qty);
                var key=cat+':'+res;
                out.quotes[key]={
                  buyPrice:safeNumber(m.getBuyPrice(cat,res)),
                  sellPrice:safeNumber(m.getSellPrice(cat,res,qty)),
                  saturation:safeNumber(m.getSaturationAmount(cat,res))
                };
              }
              return out;
            }catch(e){ return {ok:false,error:String(e)}; }
          },

          applyMarket:function(payload){
            try{
              var m=getMarket();
              if(!m) return {ok:false, error:'market missing'};
              var buys = payload && Array.isArray(payload.buySelections) ? payload.buySelections : [];
              var sells = payload && Array.isArray(payload.sellSelections) ? payload.sellSelections : [];

              // Normalize: {category, resource, quantity}
              function norm(x){
                return {
                  category:String(x.category||''),
                  resource:String(x.resource||''),
                  quantity:safeNumber(x.quantity)
                };
              }
              m.buySelections = buys.map(norm);
              m.sellSelections = sells.map(norm);

              // Ensure running if asked
              var any = false;
              for(var i=0;i<m.buySelections.length;i++){ if(m.buySelections[i].quantity>0){ any=true; break; } }
              if(!any){ for(var j=0;j<m.sellSelections.length;j++){ if(m.sellSelections[j].quantity>0){ any=true; break; } } }

              if(payload && payload.forceStart && any){
                if(!m.isActive && typeof m.canStart==='function' && m.canStart()){
                  if(typeof m.start==='function') m.start(resources);
                }
                // keep continuous if possible
                m.autoStart = true;
              }

              // Refresh UI if possible
              if(typeof m.updateSelectedResources==='function') m.updateSelectedResources();
              if(typeof m.applySelectionsToInputs==='function') m.applySelectionsToInputs();
              if(typeof updateProjectUI==='function') updateProjectUI('galactic_market');

              return {ok:true};
            }catch(e){ return {ok:false,error:String(e)}; }
          }
        };
      })();
    `;

    const s = document.createElement('script');
    s.textContent = code;
    document.documentElement.appendChild(s);
    s.remove();
  }

  function api(){ return W[BRIDGE_NAME]; }

  function ensureBridgeReady(){
    injectBridge();
    const A = api();
    return A && typeof A.ready === 'function' && A.ready();
  }

  // -------------------- UI (left hover dock) --------------------
  const UI = {
    root: null,
    body: null,
    statusLine: null,
    resourceList: null,
    planetKey: '',
    rows: new Map(), // rk -> {els...}
    lastSnapshot: null,
  };

  function applyDockLayout(open){
    const cw = clamp(settings.collapsedWidth, 18, 80);
    const ew = clamp(settings.expandedWidth, 220, 520);
    const rail = open ? ew : cw;
    document.documentElement.style.setProperty('--ttwa-rail', rail + 'px');

    const gc = document.getElementById('game-container');
    if (gc) {
      gc.style.marginLeft = rail + 'px';
      gc.style.width = `calc(100% - ${rail}px)`;
      gc.style.transition = 'margin-left 140ms ease, width 140ms ease';
    }
  }

  function buildUI(){
    if (UI.root) return;

    const style = document.createElement('style');
    style.textContent = `
      :root{ --ttwa-rail: ${clamp(settings.collapsedWidth,18,80)}px; }
      #ttwa2-root{
        position:fixed; left:0; top:0; bottom:0;
        width:${clamp(settings.expandedWidth,220,520)}px;
        transform: translateX(calc(var(--ttwa-rail) - ${clamp(settings.expandedWidth,220,520)}px));
        transition: transform 140ms ease;
        z-index:999999;
        pointer-events:auto;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      }
      body.ttwa2-open #ttwa2-root{ transform: translateX(0); }
      #ttwa2-panel{
        height:100%;
        background: rgba(18,18,22,0.94);
        color:#eaeaf0;
        border-right:1px solid rgba(255,255,255,0.12);
        box-shadow: 0 0 24px rgba(0,0,0,0.35);
        display:flex;
        flex-direction:column;
      }
      #ttwa2-header{
        display:flex; align-items:center; gap:8px;
        padding:8px 10px;
        border-bottom:1px solid rgba(255,255,255,0.10);
        background: rgba(0,0,0,0.18);
      }
      #ttwa2-title{ font-weight:900; font-size:13px; letter-spacing:0.2px; }
      #ttwa2-spacer{ flex:1; }
      .ttwa2-btn{
        border:1px solid rgba(255,255,255,0.14);
        background: rgba(255,255,255,0.06);
        color:#eaeaf0;
        border-radius:8px;
        padding:4px 8px;
        font-size:12px;
        cursor:pointer;
      }
      .ttwa2-btn.primary{ background: rgba(84,190,116,0.18); border-color: rgba(84,190,116,0.35); }
      .ttwa2-btn.danger{ background: rgba(230,90,90,0.14); border-color: rgba(230,90,90,0.35); }
      .ttwa2-btn.small{ padding:3px 7px; font-size:11px; border-radius:8px; }
      .ttwa2-btn:active{ transform: translateY(1px); }

      #ttwa2-body{ padding:10px; overflow:auto; display:flex; flex-direction:column; gap:10px; }
      .ttwa2-card{ border:1px solid rgba(255,255,255,0.10); border-radius:12px; background: rgba(255,255,255,0.04); padding:10px; }
      .ttwa2-mini{ font-size:11px; opacity:0.86; }
      .ttwa2-muted{ opacity:0.70; }
      .ttwa2-kv{ display:flex; justify-content:space-between; gap:8px; align-items:baseline; }
      .ttwa2-badge{
        display:inline-block;
        padding:2px 6px;
        border:1px solid rgba(255,255,255,0.14);
        border-radius:999px;
        font-size:11px;
        opacity:0.92;
        background: rgba(255,255,255,0.04);
        margin-right:6px;
      }

      .ttwa2-reslist{ display:flex; flex-direction:column; gap:8px; }
      .ttwa2-row{
        border:1px solid rgba(255,255,255,0.10);
        border-radius:12px;
        background: rgba(0,0,0,0.10);
        padding:8px;
        display:flex;
        flex-direction:column;
        gap:8px;
      }
      .ttwa2-topline{ display:flex; gap:8px; align-items:baseline; }
      .ttwa2-rname{ font-weight:800; font-size:12px; flex:1; text-transform:none; }
      .ttwa2-right{ text-align:right; }
      .ttwa2-controls{
        display:grid;
        grid-template-columns: 1fr 90px 74px;
        gap:8px;
        align-items:center;
      }
      .ttwa2-subcontrols{
        display:flex; gap:10px; align-items:center; flex-wrap:wrap;
      }
      .ttwa2-select, .ttwa2-input{
        width:100%;
        background: rgba(0,0,0,0.22);
        border:1px solid rgba(255,255,255,0.14);
        color:#eaeaf0;
        border-radius:10px;
        padding:5px 7px;
        font-size:12px;
        outline:none;
      }
      .ttwa2-input{ text-align:right; }
      .ttwa2-check{ display:flex; gap:6px; align-items:center; font-size:12px; opacity:0.92; }
      .ttwa2-check input{ transform: translateY(1px); }
      .ttwa2-disabled{ opacity:0.55; pointer-events:none; }
      .ttwa2-tag{
        font-size:11px;
        opacity:0.75;
        border:1px solid rgba(255,255,255,0.10);
        padding:2px 6px;
        border-radius:999px;
      }
    `;
    document.head.appendChild(style);

    // Apply initial rail to game container
    applyDockLayout(false);

    const root = document.createElement('div');
    root.id = 'ttwa2-root';
    root.innerHTML = `
      <div id="ttwa2-panel">
        <div id="ttwa2-header">
          <div id="ttwa2-title">TT Worker Allocator</div>
          <div class="ttwa2-mini ttwa2-muted" id="ttwa2-planet" style="margin-left:6px"></div>
          <div id="ttwa2-spacer"></div>
          <button id="ttwa2-run" class="ttwa2-btn primary">Running</button>
          <button id="ttwa2-pin" class="ttwa2-btn small">Pin</button>
        </div>
        <div id="ttwa2-body">
          <div class="ttwa2-card">
            <div class="ttwa2-kv"><div class="ttwa2-mini">Workers</div><div class="ttwa2-mini" id="ttwa2-workers"></div></div>
            <div class="ttwa2-kv"><div class="ttwa2-mini">Funding</div><div class="ttwa2-mini" id="ttwa2-funding"></div></div>
            <div class="ttwa2-mini ttwa2-muted" id="ttwa2-status" style="margin-top:6px"></div>
          </div>
          <div class="ttwa2-card">
            <div style="font-weight:900; font-size:12px; margin-bottom:8px">Resources (modes + market)</div>
            <div class="ttwa2-reslist" id="ttwa2-reslist"></div>
          </div>
          <div class="ttwa2-card">
            <div style="font-weight:900; font-size:12px; margin-bottom:6px">Tuning</div>
            <div class="ttwa2-kv ttwa2-mini"><div class="ttwa2-muted">Reserve workers</div><div><input id="ttwa2-reserve" class="ttwa2-input" type="number" min="0" max="50" step="0.5" style="width:90px" /></div></div>
            <div class="ttwa2-kv ttwa2-mini" style="margin-top:6px"><div class="ttwa2-muted">Funding buffer (s)</div><div><input id="ttwa2-fundbuf" class="ttwa2-input" type="number" min="0" max="120" step="1" style="width:90px" /></div></div>
          </div>
          <div class="ttwa2-mini ttwa2-muted" style="padding:2px 2px 10px 2px">
            Tip: Hover left edge to open. Pin keeps it open. Modes: <b>On</b>=build+activate, <b>Balance</b>=activate only, <b>Off</b>=script leaves it alone.
          </div>
        </div>
      </div>
    `;
    document.body.appendChild(root);

    UI.root = root;
    UI.body = root.querySelector('#ttwa2-body');
    UI.statusLine = root.querySelector('#ttwa2-status');
    UI.resourceList = root.querySelector('#ttwa2-reslist');

    const planetEl = root.querySelector('#ttwa2-planet');
    const runBtn = root.querySelector('#ttwa2-run');
    const pinBtn = root.querySelector('#ttwa2-pin');
    const reserveInp = root.querySelector('#ttwa2-reserve');
    const fundBufInp = root.querySelector('#ttwa2-fundbuf');

    reserveInp.value = String(settings.reserveWorkersPct);
    fundBufInp.value = String(settings.fundingBufferSeconds);

    function refreshButtons(){
      runBtn.textContent = settings.running ? 'Running' : 'Stopped';
      runBtn.classList.toggle('danger', !settings.running);
      runBtn.classList.toggle('primary', settings.running);

      pinBtn.textContent = settings.pinned ? 'Unpin' : 'Pin';
      pinBtn.classList.toggle('primary', settings.pinned);
    }
    refreshButtons();

    runBtn.addEventListener('click', () => {
      settings.running = !settings.running;
      saveSettings();
      refreshButtons();
    });
    pinBtn.addEventListener('click', () => {
      settings.pinned = !settings.pinned;
      saveSettings();
      refreshButtons();
      if (settings.pinned) {
        document.body.classList.add('ttwa2-open');
        applyDockLayout(true);
      }
    });
    reserveInp.addEventListener('change', () => {
      settings.reserveWorkersPct = clamp(reserveInp.value, 0, 50);
      reserveInp.value = String(settings.reserveWorkersPct);
      saveSettings();
    });
    fundBufInp.addEventListener('change', () => {
      settings.fundingBufferSeconds = clamp(fundBufInp.value, 0, 120);
      fundBufInp.value = String(settings.fundingBufferSeconds);
      saveSettings();
    });

    // Hover open behavior
    let hoverOpen = false;
    const onOpen = () => {
      if (settings.pinned) return;
      if (hoverOpen) return;
      hoverOpen = true;
      document.body.classList.add('ttwa2-open');
      applyDockLayout(true);
    };
    const onClose = () => {
      if (settings.pinned) return;
      if (!hoverOpen) return;
      hoverOpen = false;
      document.body.classList.remove('ttwa2-open');
      applyDockLayout(false);
    };

    // Entering the rail opens; leaving the entire panel closes
    const rail = document.createElement('div');
    rail.style.position = 'fixed';
    rail.style.left = '0';
    rail.style.top = '0';
    rail.style.bottom = '0';
    rail.style.width = clamp(settings.collapsedWidth, 18, 80) + 'px';
    rail.style.zIndex = '999998';
    rail.style.background = 'transparent';
    rail.addEventListener('mouseenter', onOpen);
    document.body.appendChild(rail);

    root.addEventListener('mouseleave', () => {
      // allow a small grace so quick moves don't jitter
      setTimeout(() => { if (!settings.pinned) onClose(); }, 120);
    });
    root.addEventListener('mouseenter', onOpen);

    // Update planet label
    UI.setPlanet = (pk) => { planetEl.textContent = pk ? `(${pk})` : ''; };
    UI.refreshButtons = refreshButtons;
  }

  function ensureResourceRow(rk, cfg, producers){
    if (UI.rows.has(rk)) return UI.rows.get(rk);

    const row = document.createElement('div');
    row.className = 'ttwa2-row';
    row.dataset.rk = rk;

    const [cat,res] = rkParts(rk);

    row.innerHTML = `
      <div class="ttwa2-topline">
        <div class="ttwa2-rname" id="n"></div>
        <div class="ttwa2-right">
          <div class="ttwa2-mini" id="fill"></div>
          <div class="ttwa2-mini ttwa2-muted" id="net"></div>
        </div>
      </div>
      <div class="ttwa2-controls">
        <div>
          <select class="ttwa2-select" id="mode">
            <option value="off">Off</option>
            <option value="on">On</option>
            <option value="balance">Balance</option>
          </select>
        </div>
        <div>
          <input class="ttwa2-input" id="weight" type="number" min="0" step="0.1" />
        </div>
        <div class="ttwa2-mini ttwa2-muted ttwa2-right" id="producerTag"></div>
      </div>
      <div class="ttwa2-subcontrols" id="sub"></div>
    `;

    const els = {
      row,
      name: row.querySelector('#n'),
      fill: row.querySelector('#fill'),
      net: row.querySelector('#net'),
      mode: row.querySelector('#mode'),
      weight: row.querySelector('#weight'),
      producerTag: row.querySelector('#producerTag'),
      sub: row.querySelector('#sub'),
      producerSel: null,
      buyChk: null,
      sellChk: null,
      marketOnlyTag: null,
    };

    UI.resourceList.appendChild(row);

    // Subcontrols: Producer dropdown (if needed), Market checkboxes.
    // Producer selector
    const hasProducer = producers && producers.length > 0;
    if (hasProducer) {
      if (producers.length > 1) {
        const sel = document.createElement('select');
        sel.className = 'ttwa2-select';
        sel.style.flex = '1';
        sel.title = 'Producer building';
        for (const b of producers) {
          const o = document.createElement('option');
          o.value = b.key;
          o.textContent = b.displayName;
          sel.appendChild(o);
        }
        els.sub.appendChild(sel);
        els.producerSel = sel;
      } else {
        const tag = document.createElement('div');
        tag.className = 'ttwa2-tag';
        tag.textContent = producers[0].displayName;
        // Put in same line as checkboxes
        els.sub.appendChild(tag);
      }
    } else {
      const tag = document.createElement('div');
      tag.className = 'ttwa2-tag';
      tag.textContent = 'Market only';
      els.sub.appendChild(tag);
      els.marketOnlyTag = tag;
    }

    // Market toggles
    const buyLbl = document.createElement('label');
    buyLbl.className = 'ttwa2-check';
    buyLbl.innerHTML = `<input type="checkbox" /> <span>Market Buy</span>`;
    const sellLbl = document.createElement('label');
    sellLbl.className = 'ttwa2-check';
    sellLbl.innerHTML = `<input type="checkbox" /> <span>Market Sell</span>`;
    els.sub.appendChild(buyLbl);
    els.sub.appendChild(sellLbl);
    els.buyChk = buyLbl.querySelector('input');
    els.sellChk = sellLbl.querySelector('input');

    // Apply initial cfg values
    els.mode.value = (cfg && cfg.mode) ? cfg.mode : 'off';
    els.weight.value = String((cfg && typeof cfg.weight==='number') ? cfg.weight : settings.defaultWeight);
    els.buyChk.checked = !!(cfg && cfg.marketBuy);
    els.sellChk.checked = !!(cfg && cfg.marketSell);

    // Producer select initial
    if (els.producerSel) {
      const pk = (cfg && cfg.producerKey) ? cfg.producerKey : producers[0].key;
      els.producerSel.value = pk;
    }

    function persist(){
      const planetCfg = getPlanetCfg(UI.planetKey);
      const cur = planetCfg[rk] || {};
      cur.mode = els.mode.value;
      cur.weight = clamp(els.weight.value, 0, 1e9);
      cur.marketBuy = !!els.buyChk.checked;
      cur.marketSell = !!els.sellChk.checked;
      if (els.producerSel) cur.producerKey = els.producerSel.value;
      else if (hasProducer) cur.producerKey = producers[0].key;
      planetCfg[rk] = cur;
      saveCfg();
    }

    els.mode.addEventListener('change', () => {
      // Off / On / Balance is already mutually exclusive via dropdown.
      persist();
      updateRowEnabledState(els, hasProducer);
    });
    els.weight.addEventListener('change', () => {
      els.weight.value = String(clamp(els.weight.value, 0, 1e9));
      persist();
    });
    els.buyChk.addEventListener('change', persist);
    els.sellChk.addEventListener('change', persist);
    if (els.producerSel) els.producerSel.addEventListener('change', persist);

    updateRowEnabledState(els, hasProducer);

    UI.rows.set(rk, els);
    return els;
  }

  function updateRowEnabledState(els, hasProducer){
    const mode = els.mode.value;
    // If no producer, disable mode/weight/producer but allow market toggles.
    if (!hasProducer) {
      els.mode.classList.add('ttwa2-disabled');
      els.weight.classList.add('ttwa2-disabled');
      if (els.producerSel) els.producerSel.classList.add('ttwa2-disabled');
      els.producerTag.textContent = '';
      return;
    }
    // If producer exists, controls available; weight disabled only if Off.
    els.mode.classList.remove('ttwa2-disabled');
    const weightDisabled = (mode === 'off');
    els.weight.classList.toggle('ttwa2-disabled', weightDisabled);
    if (els.producerSel) els.producerSel.classList.remove('ttwa2-disabled');
    els.producerTag.textContent = (mode === 'on') ? 'On' : (mode === 'balance') ? 'Balance' : 'Off';
  }

  // -------------------- Core Logic --------------------
  function computeDesiredAutoBuildPercent(workerCap, desiredWorkers, effNeed){
    if (!(workerCap > 0) || !(effNeed > 0) || !(desiredWorkers >= 0)) return 0;
    const desiredCount = desiredWorkers / effNeed;
    const pct = (desiredCount / workerCap) * 100;
    // Percent can be tiny; keep a lot of precision.
    return Math.max(0, pct);
  }

  function buildProducerMap(snapshot){
    const producersByRk = new Map(); // rk -> buildings[]
    for (const b of snapshot.buildings || []) {
      for (const rk of (b.produces || [])) {
        if (!producersByRk.has(rk)) producersByRk.set(rk, []);
        producersByRk.get(rk).push(b);
      }
    }
    return producersByRk;
  }

  function chooseProducer(rk, cfg, producers){
    if (!producers || producers.length === 0) return null;
    const want = cfg && cfg.producerKey;
    if (want) {
      const found = producers.find(p => p.key === want);
      if (found) return found;
    }
    // Prefer the largest existing line (count), else first.
    let best = producers[0];
    for (const p of producers) {
      if ((p.count||0) > (best.count||0)) best = p;
    }
    return best;
  }

  function updateUIFromSnapshot(snapshot){
    UI.lastSnapshot = snapshot;
    UI.planetKey = snapshot.planetKey || 'default';
    UI.setPlanet && UI.setPlanet(UI.planetKey);

    const workersEl = UI.root.querySelector('#ttwa2-workers');
    const fundingEl = UI.root.querySelector('#ttwa2-funding');

    const wc = toNum(snapshot.workerCap);
    const wf = toNum(snapshot.workerFree);
    workersEl.innerHTML = `<span class="ttwa2-badge">cap ${escapeHtml(fmtNum(wc))}</span><span class="ttwa2-badge">free ${escapeHtml(fmtNum(wf))}</span>`;
    fundingEl.innerHTML = `<span class="ttwa2-badge">${escapeHtml(fmtNum(toNum(snapshot.funding)))}</span>`;

    const planetCfg = getPlanetCfg(UI.planetKey);
    const producersByRk = buildProducerMap(snapshot);

    // Market keys define which resources we show.
    const marketKeys = (snapshot.market && Array.isArray(snapshot.market.keys)) ? snapshot.market.keys.slice() : [];
    marketKeys.sort((a,b)=>a.localeCompare(b));

    const existing = new Set(UI.rows.keys());
    for (const rk of marketKeys) {
      const producers = producersByRk.get(rk) || [];
      const cfg = planetCfg[rk] || {};
      // ensure default weight exists once you turn it on
      if (cfg.weight == null) cfg.weight = settings.defaultWeight;

      const els = ensureResourceRow(rk, cfg, producers);

      // Update producer select options if the producer set changed
      if (els.producerSel) {
        const existingOptions = Array.from(els.producerSel.options).map(o => o.value).join('|');
        const newOptions = producers.map(p => p.key).join('|');
        if (existingOptions !== newOptions) {
          els.producerSel.innerHTML = '';
          for (const b of producers) {
            const o = document.createElement('option');
            o.value = b.key;
            o.textContent = b.displayName;
            els.producerSel.appendChild(o);
          }
        }
        const picked = (cfg.producerKey && producers.find(p => p.key === cfg.producerKey)) ? cfg.producerKey : producers[0]?.key;
        if (picked && els.producerSel.value !== picked) els.producerSel.value = picked;
      }

      // Update labels with live resource state
      const st = snapshot.res && snapshot.res[rk];
      if (st) {
        els.name.textContent = st.displayName || rk;
        if (st.cap > 0 && Number.isFinite(st.cap)) {
          const fill = (st.value / st.cap) * 100;
          els.fill.textContent = `${fill.toFixed(1)}%`;
        } else {
          els.fill.textContent = fmtNum(st.value);
        }
        const net = toNum(st.net);
        els.net.textContent = `${net>=0?'+':''}${fmtNum(net)}/s`;
      } else {
        els.name.textContent = rk;
        els.fill.textContent = '';
        els.net.textContent = '';
      }

      // Enable/disable based on producer existence
      updateRowEnabledState(els, producers.length > 0);

      existing.delete(rk);
    }

    // Remove stale rows
    for (const rk of existing) {
      const els = UI.rows.get(rk);
      if (els && els.row && els.row.parentNode) els.row.parentNode.removeChild(els.row);
      UI.rows.delete(rk);
    }
  }

  function desiredBuyQty(st){
    // st: resource state
    if (!st || !st.unlocked) return 0;
    const cap = toNum(st.cap);
    const val = toNum(st.value);
    const net = toNum(st.net);
    const shortage = !!st.autobuildShortage;
    let qty = 0;

    if (cap > 0 && Number.isFinite(cap)) {
      const fill = val / cap;
      if (shortage) {
        const targetFill = clamp(settings.buyTargetFillOnShortage, 0.05, 0.95);
        const want = Math.max(0, targetFill * cap - val);
        qty = Math.max(qty, want / Math.max(3, settings.buyRefillSeconds));
      }
      if (net < 0) {
        qty = Math.max(qty, -net);

        const bufferSec = Math.max(5, settings.buyBufferSeconds);
        let desiredStock = (-net) * bufferSec;
        const maxFill = clamp(settings.buyMaxFill, 0.1, 0.95);
        desiredStock = Math.min(desiredStock, cap * maxFill);
        if (val < desiredStock) {
          qty += (desiredStock - val) / bufferSec;
        }
      }
    } else {
      if (shortage && val <= 0) qty = 1;
      if (net < 0) qty = Math.max(qty, -net);
    }

    // clamp & sanitize
    if (!Number.isFinite(qty) || qty < 0) qty = 0;
    // avoid extremely noisy sub-unit buys
    return Math.floor(qty);
  }

  function baselineSellQty(st){
    if (!st || !st.unlocked) return 0;
    if (st.autobuildShortage) return 0; // never sell while construction is short
    const cap = toNum(st.cap);
    const val = toNum(st.value);
    const net = toNum(st.net);

    let qty = 0;

    // Always allow selling "surplus flow"
    if (net > 0) qty += net;

    // Bleed down if very full
    if (cap > 0 && Number.isFinite(cap)) {
      const fill = val / cap;
      const high = clamp(settings.sellHighFill, 0.1, 0.99);
      const target = clamp(settings.sellTargetFill, 0.1, 0.99);
      const horizon = Math.max(10, settings.sellDrainHorizonSeconds);
      if (fill > high && target < fill) {
        qty += ((fill - target) * cap) / horizon;
      }
    }

    if (!Number.isFinite(qty) || qty < 0) qty = 0;
    return Math.floor(qty);
  }

  function computeMaxExtraSellRate(st){
    if (!st || !st.unlocked) return 0;
    if (st.autobuildShortage) return 0;
    const cap = toNum(st.cap);
    const val = toNum(st.value);
    const net = toNum(st.net);
    const horizon = Math.max(10, settings.sellDrainHorizonSeconds);
    const minFill = clamp(settings.sellMinFill, 0, 0.95);

    let drain = 0;
    if (cap > 0 && Number.isFinite(cap)) {
      const minStock = cap * minFill;
      drain = Math.max(0, val - minStock) / horizon;
    } else {
      drain = Math.max(0, val) / horizon;
    }

    // allow selling beyond net by draining stock, but never below minFill.
    return Math.max(0, net) + drain;
  }

  function scaleDownBuysByFunding(buys, quotes, fundingValue){
    // Keep some buffer: totalSpendPerSec <= fundingValue / bufferSeconds.
    const buf = Math.max(1, settings.fundingBufferSeconds);
    const maxSpend = Math.max(0, fundingValue) / buf;

    let spend = 0;
    for (const [rk, qty] of Object.entries(buys)) {
      if (!(qty > 0)) continue;
      const q = quotes[rk];
      if (!q) continue;
      spend += qty * toNum(q.buyPrice);
    }
    if (spend <= maxSpend || spend <= 0) return buys;

    const f = maxSpend / spend;
    const out = {};
    for (const [rk, qty] of Object.entries(buys)) {
      out[rk] = Math.floor(qty * f);
    }
    return out;
  }

  function computeMarketPlan(snapshot, planetCfg){
    const market = snapshot.market || {unlocked:false};
    const enabled = settings.marketEnabled && market.unlocked;
    if (!enabled) return { buySelections:[], sellSelections:[], debug:'' };

    // Desired quantities (per second)
    const buys = {};
    const sells = {};

    const keys = (market.keys || []).slice();

    for (const rk of keys) {
      const cfg = planetCfg[rk] || {};
      const st = snapshot.res ? snapshot.res[rk] : null;
      if (cfg.marketBuy) buys[rk] = desiredBuyQty(st);
      if (cfg.marketSell) sells[rk] = baselineSellQty(st);
    }

    // Quote all involved resources
    const quoteEntries = [];
    for (const rk of keys) {
      if ((buys[rk] > 0) || (sells[rk] > 0)) {
        const [cat,res] = rkParts(rk);
        quoteEntries.push({category:cat, resource:res, qty: Math.max(1, sells[rk]||0)});
      }
    }
    const quoteResp = api().getMarketQuotes({entries: quoteEntries});
    const quotes = (quoteResp && quoteResp.ok && quoteResp.quotes) ? quoteResp.quotes : {};

    // Funding safety: scale buys by buffer
    const fundingValue = toNum(snapshot.funding);
    const scaledBuys = scaleDownBuysByFunding(buys, quotes, fundingValue);

    // Recompute cost/revenue and then add more sells to cover if possible.
    function totals(curBuys, curSells){
      let cost = 0, rev = 0;
      for (const [rk, qty] of Object.entries(curBuys)) {
        if (!(qty>0)) continue;
        const q = quotes[rk]; if (!q) continue;
        cost += qty * toNum(q.buyPrice);
      }
      for (const [rk, qty] of Object.entries(curSells)) {
        if (!(qty>0)) continue;
        const q = quotes[rk]; if (!q) continue;
        // sell price depends on qty; re-quote with current qty if needed
        // (quotes already computed at qty), acceptable approximation.
        rev += qty * toNum(q.sellPrice);
      }
      return {cost, rev};
    }

    const curSells = Object.assign({}, sells);
    let {cost, rev} = totals(scaledBuys, curSells);

    // If cost > rev, try to raise sells (prefer those with large available extra capacity).
    let iterations = 0;
    const sellCandidates = keys
      .filter(rk => (planetCfg[rk] && planetCfg[rk].marketSell))
      .map(rk => ({rk}))
      .filter(x => snapshot.res && snapshot.res[x.rk]);

    while (cost > rev && iterations < 12 && sellCandidates.length > 0) {
      const short = cost - rev;

      // Pick best candidate by (sellPrice * maxExtraRate)
      let best = null;
      for (const c of sellCandidates) {
        const st = snapshot.res[c.rk];
        if (!st || st.autobuildShortage) continue;

        const maxRate = computeMaxExtraSellRate(st);
        const cur = curSells[c.rk] || 0;
        const extraCap = Math.max(0, maxRate - cur);
        if (!(extraCap > 0)) continue;

        const q = quotes[c.rk];
        const price = q ? toNum(q.sellPrice) : 0;
        const score = price * extraCap;
        if (!best || score > best.score) best = {rk:c.rk, score, extraCap, price};
      }

      if (!best || !(best.price > 0) || !(best.extraCap > 0)) break;

      const needUnits = short / best.price;
      const add = Math.min(best.extraCap, needUnits * 1.05); // small cushion
      curSells[best.rk] = Math.floor((curSells[best.rk] || 0) + add);

      // Update that resource's sell quote for better accuracy (price changes with qty)
      const [cat,res] = rkParts(best.rk);
      const reQuote = api().getMarketQuotes({entries:[{category:cat, resource:res, qty: Math.max(1, curSells[best.rk])}]});
      if (reQuote && reQuote.ok && reQuote.quotes && reQuote.quotes[best.rk]) {
        quotes[best.rk].sellPrice = reQuote.quotes[best.rk].sellPrice;
      }

      ({cost, rev} = totals(scaledBuys, curSells));
      iterations++;
    }

    // Build selections arrays
    const buySelections = [];
    const sellSelections = [];

    for (const rk of keys) {
      const [cat,res] = rkParts(rk);
      const bq = scaledBuys[rk] || 0;
      const sq = curSells[rk] || 0;
      buySelections.push({category:cat, resource:res, quantity: bq});
      sellSelections.push({category:cat, resource:res, quantity: sq});
    }

    const net = rev - cost;
    const debug = `Market: cost ${fmtNum(cost)}/s, rev ${fmtNum(rev)}/s, net ${net>=0?'+':''}${fmtNum(net)}/s`;
    return { buySelections, sellSelections, debug, any: (cost>0 || rev>0) };
  }

  function applyWorkerPlan(snapshot){
    const planetCfg = getPlanetCfg(UI.planetKey);

    const producersByRk = buildProducerMap(snapshot);
    const workerCap = toNum(snapshot.workerCap);
    if (!(workerCap > 0)) return {ok:true, changed:0};

    // Allocation pool
    const reservePct = clamp(settings.reserveWorkersPct, 0, 50) / 100;
    const allocWorkers = workerCap * (1 - reservePct);

    // Collect resources with mode On/Balance and having a producer
    const items = [];
    for (const [rk, cfg] of Object.entries(planetCfg)) {
      if (!cfg) continue;
      const mode = cfg.mode || 'off';
      if (mode === 'off') continue;
      const producers = producersByRk.get(rk) || [];
      if (!producers.length) continue;
      const prod = chooseProducer(rk, cfg, producers);
      if (!prod) continue;
      const weight = Math.max(0, toNum(cfg.weight, settings.defaultWeight));
      items.push({rk, cfg, mode, weight, prod});
    }

    // If nothing enabled, do nothing.
    if (!items.length) return {ok:true, changed:0};

    let sumW = items.reduce((a,x)=>a + x.weight, 0);
    if (!(sumW > 0)) sumW = items.length;

    // Build updates for buildings
    const updates = {};

    for (const it of items) {
      const share = (it.weight > 0 ? it.weight : 1) / sumW;
      const desiredWorkers = allocWorkers * share;
      const pct = computeDesiredAutoBuildPercent(workerCap, desiredWorkers, toNum(it.prod.effNeed));
      updates[it.prod.key] = {
        autoBuildBasis: 'workers',
        autoBuildPercent: pct,
        autoActiveEnabled: true,
        autoBuildEnabled: (it.mode === 'on')
      };
    }

    // Also handle Off: if a cfg row is explicitly off AND it has a producer, turn off automation for that producer,
    // but only if that producer is selected for that resource. This prevents leaving stale flags behind.
    for (const [rk, cfg] of Object.entries(planetCfg)) {
      if (!cfg) continue;
      const mode = cfg.mode || 'off';
      if (mode !== 'off') continue;
      const producers = producersByRk.get(rk) || [];
      if (!producers.length) continue;
      const prod = chooseProducer(rk, cfg, producers);
      if (!prod) continue;
      // Only disable if we previously controlled it (basis workers or auto flags on). Safe but conservative.
      if (prod.autoBuildBasis === 'workers' || prod.autoBuildEnabled || prod.autoActiveEnabled) {
        updates[prod.key] = Object.assign(updates[prod.key] || {}, {
          autoActiveEnabled: false,
          autoBuildEnabled: false
        });
      }
    }

    const resp = api().applyBuildings(updates);
    if (!resp || !resp.ok) {
      TT.setError(resp ? resp.error : 'applyBuildings failed');
      return {ok:false, error: resp ? resp.error : 'applyBuildings failed'};
    }
    return {ok:true, changed:Object.keys(updates).length};
  }

  function applyMarketPlan(snapshot){
    const planetCfg = getPlanetCfg(UI.planetKey);
    const plan = computeMarketPlan(snapshot, planetCfg);

    if (UI.statusLine) {
      UI.statusLine.textContent = plan.debug || '';
    }

    if (!settings.running) return {ok:true};
    if (!settings.marketEnabled) return {ok:true};
    if (!snapshot.market || !snapshot.market.unlocked) return {ok:true};

    const resp = api().applyMarket({
      buySelections: plan.buySelections,
      sellSelections: plan.sellSelections,
      forceStart: !!plan.any
    });
    if (!resp || !resp.ok) {
      TT.setError(resp ? resp.error : 'applyMarket failed');
      return {ok:false, error: resp ? resp.error : 'applyMarket failed'};
    }
    return {ok:true};
  }

  // -------------------- Main Loop --------------------
  let loopTimer = null;
  function loop(){
    try{
      if (!TT.isMasterEnabled()) return;
      if (TT.isPaused()) return;

      if (!ensureBridgeReady()) return;

      buildUI();

      const snap = api().snapshot();
      if (!snap) return;

      updateUIFromSnapshot(snap);

      if (!settings.running) return;

      // Apply building plan first (affects net rates), then market.
      applyWorkerPlan(snap);
      applyMarketPlan(snap);
    } catch (e) {
      TT.setError(String(e && e.message ? e.message : e));
      // pause briefly to avoid spam
      TT.setPaused(2000, 'error');
    }
  }

  function start(){
    injectBridge();
    if (loopTimer) clearInterval(loopTimer);
    loopTimer = setInterval(loop, clamp(settings.tickMs, 250, 5000));
    loop();
  }

  start();
})();
