// ==UserScript==
// @name         Terraforming Titans Worker Allocator (Live + Scaled Safeguards + Max Learn) [Firefox Fixed + UI Dock]
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      1.0.2
// @description  Worker allocator overlay + safeguards + MAX weight learning. Firefox/Violentmonkey compatible. Writes autoBuildPercent for worker-basis buildings to realize a target allocation plan.
// @author       kov27
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @downloadURL  https://raw.githubusercontent.com/kov27/Terraforming-Titans-Scripts/main/scripts/worker-allocation.user.js
// @updateURL    https://raw.githubusercontent.com/kov27/Terraforming-Titans-Scripts/main/scripts/worker-allocation.user.js
// @grant        unsafeWindow
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';
// ===================== TT Shared Runtime (cross-script contract) =====================
// Shared across ALL userscripts on the same page via unsafeWindow.__TT_SHARED__
// Persists masterEnabled via localStorage key: tt.masterEnabled
const TT = (() => {
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
  const LS = (() => {
    try { return W.localStorage; } catch { return null; }
  })();

  const scriptName =
    (typeof GM_info !== 'undefined' && GM_info?.script?.name) ? GM_info.script.name :
    'TT-Script';

  const shared = W.__TT_SHARED__ || (W.__TT_SHARED__ = {
    masterEnabled: true,
    pauseUntil: 0,
    locks: {},        // { [name]: { owner, expiresAt } }
    lastAction: '',   // string
    lastError: '',    // string
  });

  // Load persisted masterEnabled once (best-effort)
  if (LS && LS.getItem('tt.masterEnabled') != null) {
    shared.masterEnabled = LS.getItem('tt.masterEnabled') === '1';
  }

  function setMasterEnabled(enabled) {
    shared.masterEnabled = !!enabled;
    if (LS) LS.setItem('tt.masterEnabled', shared.masterEnabled ? '1' : '0');
    note(`MASTER ${shared.masterEnabled ? 'ON' : 'OFF'}`);
  }

  function isPaused() {
    return Date.now() < (shared.pauseUntil || 0);
  }

  function pause(ms, reason = '') {
    const until = Date.now() + Math.max(0, ms | 0);
    shared.pauseUntil = Math.max(shared.pauseUntil || 0, until);
    note(`PAUSE ${ms}ms${reason ? `: ${reason}` : ''}`);
  }

  function note(msg) {
    const line = `[${new Date().toISOString()}] ${scriptName}: ${msg}`;
    shared.lastAction = line;
    // Keep console noise low; comment out if you want it quieter.
    console.debug(line);
  }

  function error(msg, err) {
    const line = `[${new Date().toISOString()}] ${scriptName}: ERROR ${msg}${err ? ` | ${String(err)}` : ''}`;
    shared.lastError = line;
    console.warn(line);
  }

  // Best-effort lock with TTL. Prevents two scripts changing the same subsystem simultaneously.
  function tryLock(name, ttlMs = 4000) {
    const now = Date.now();
    const lock = shared.locks[name];
    if (lock && lock.expiresAt > now && lock.owner !== scriptName) return false;

    shared.locks[name] = { owner: scriptName, expiresAt: now + Math.max(250, ttlMs | 0) };
    return true;
  }

  function unlock(name) {
    const lock = shared.locks[name];
    if (lock && lock.owner === scriptName) delete shared.locks[name];
  }

  function shouldRun() {
    return !!shared.masterEnabled && !isPaused();
  }

  // Convenience wrapper: runs fn only if enabled+not paused+lock acquired.
  function runExclusive(lockName, ttlMs, fn) {
    if (!shouldRun()) return false;
    if (!tryLock(lockName, ttlMs)) return false;

    try {
      fn();
      return true;
    } catch (e) {
      error(`runExclusive(${lockName})`, e);
      // Auto-pause briefly on repeated failures to avoid runaway loops
      pause(2000, `exception in ${lockName}`);
      return false;
    } finally {
      unlock(lockName);
    }
  }

  // Optional: quick console helpers
  W.__TT = {
    shared,
    setMasterEnabled,
    pause,
  };

  return {
    shared,
    scriptName,
    setMasterEnabled,
    isPaused,
    pause,
    note,
    error,
    tryLock,
    unlock,
    shouldRun,
    runExclusive,
  };
})();
// ===================== /TT Shared Runtime =====================

  /**
   * MAINTENANCE NOTES (for ChatGPT / future automated edits)
   *
   * Dataflow:
   *   (1) Bridge -> snapshot() reads live game state (resources + buildings)
   *   (2) ensureRows(snapshot) syncs UI rows + persisted rowState (enabled/weight)
   *   (3) adjustSafeguards(snapshot) updates boostPctByKey (persistent %worker reserve) based on buffer logic
   *   (4) maxLearnTick(snapshot) optionally mutates weights via stochastic hill-climb to maximize selected output
   *   (5) computePlan(snapshot) builds a targetCountByKey for worker-basis buildings, honoring:
   *         - fixed-demand (non-workers basis) buildings (reserved first)
   *         - minimum floors (Min toggles) with deficit-scaled strength
   *         - emergency floors (buffer + cap-deficit severity) distributed to producers
   *         - persistent boosts (boostPctByKey)
   *         - weights distributing remaining workers
   *         - final overshoot trimming + slack fill
   *   (6) applyPlan(plan) writes autoBuildPercent for each worker-basis building:
   *         pct = targetBuildingCount / workerCap * 100
   *
   * Invariants / constraints:
   *   - We only touch worker-basis buildings (autoBuildBasis === 'workers') for allocation.
   *   - Game interprets autoBuildPercent with base=workerCap, yielding target building counts.
   *   - We convert desired worker allocation -> building count via ceil(workers / effNeed).
   *   - Colonists + Androids are treated as cap-maintained resources:
   *         * request positive net until near-cap (even if consumption==0)
   *         * if consumption>0, enforce a small positive margin
   *         * emergency severity includes cap-deficit term (works even when consumption==0)
   *
   * UI architecture:
   *   - Minimal header (Start/Stop + Minimize)
   *   - Status card: high-signal summary (Workers + Pop caps + Max/learning score)
   *   - Allocation card: controls + table
   *   - All explanatory text is delivered via tooltips (single tooltip component)
   */

  // ---------------- VM/Firefox sandbox bridge ----------------
  var __UW__ = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  var __PAGE__ = (__UW__ && __UW__.wrappedJSObject) ? __UW__.wrappedJSObject : __UW__;

  function getPageProp(name) {
    try { if (__PAGE__ && typeof __PAGE__[name] !== 'undefined') return __PAGE__[name]; } catch (e) {}
    try { if (__UW__ && typeof __UW__[name] !== 'undefined') return __UW__[name]; } catch (e2) {}
    return undefined;
  }

  // Direct API fallback (when script injection is blocked).
  var __DIRECT_API__ = null;

  function getDirectApi() {
    if (__DIRECT_API__) return __DIRECT_API__;

    function safeNumber(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }
    function getPath(root, path) {
      try {
        var cur = root;
        for (var i = 0; i < path.length; i++) { if (!cur) return undefined; cur = cur[path[i]]; }
        return cur;
      } catch (e) { return undefined; }
    }
    function effectiveWorkerNeed(b) {
      try {
        var base = 0;
        if (b && typeof b.getTotalWorkerNeed === 'function') base = safeNumber(b.getTotalWorkerNeed());
        else base = safeNumber(b ? b.requiresWorker : 0);
        var mult = 1;
        if (b && typeof b.getEffectiveWorkerMultiplier === 'function') mult = safeNumber(b.getEffectiveWorkerMultiplier());
        if (!mult) mult = 1;
        return base * mult;
      } catch (e) { return 0; }
    }
    function computeTargetCount(b, pop, workerCap, collection) {
      try {
        var basis = String((b && b.autoBuildBasis) ? b.autoBuildBasis : 'population');
        if (basis === 'max') return Infinity;
        var base = 0;
        if (b && typeof b.getAutoBuildBase === 'function') base = safeNumber(b.getAutoBuildBase(pop, workerCap, collection));
        else base = (basis === 'workers') ? safeNumber(workerCap) : safeNumber(pop);
        var pct = safeNumber(b ? b.autoBuildPercent : 0);
        return Math.ceil((pct * safeNumber(base)) / 100);
      } catch (e) { return 0; }
    }
    function isNonZeroConsumptionEntry(v) {
      if (v == null) return false;
      if (typeof v === 'number') return v !== 0;
      if (typeof v === 'object') {
        if (typeof v.amount === 'number') return v.amount !== 0;
        for (var k in v) { if (typeof v[k] === 'number' && v[k] !== 0) return true; }
      }
      return false;
    }
    function collectProducedKeys(b) {
      var out = [];
      var prod = b && b.production ? b.production : {};
      for (var cat in prod) {
        if (cat !== 'colony' && cat !== 'special') continue;
        var obj = prod[cat];
        if (!obj || typeof obj !== 'object') continue;
        for (var res in obj) out.push(cat + ':' + res);
      }
      return out;
    }
    function hasExternalInputs(b) {
      var cons = b && b.consumption ? b.consumption : {};
      for (var cat in cons) {
        if (cat === 'colony' || cat === 'special') continue;
        var obj = cons[cat];
        if (!obj || typeof obj !== 'object') continue;
        for (var res in obj) { if (isNonZeroConsumptionEntry(obj[res])) return true; }
      }
      return false;
    }
    function getResState(resources, cat, res) {
      try {
        var r = resources && resources[cat] ? resources[cat][res] : null;
        if (!r) return null;
        var prod = safeNumber(r.productionRate);
        var cons = safeNumber(r.consumptionRate);
        return {
          value: safeNumber(r.value),
          cap: safeNumber(r.cap),
          prod: prod,
          cons: cons,
          net: prod - cons,
          overflow: safeNumber(r.overflowRate),
          unlocked: !!r.unlocked
        };
      } catch (e) { return null; }
    }

    __DIRECT_API__ = {
      mode: 'direct',
      ready: function () {
        try {
          var resources = getPageProp('resources');
          var buildings = getPageProp('buildings');
          return !!(buildings && resources && resources.colony && resources.colony.workers);
        } catch (e) { return false; }
      },
      snapshot: function () {
        var resources = getPageProp('resources');
        var collection = getPageProp('buildings') || {};

        var popV = safeNumber(getPath(resources, ['colony', 'colonists', 'value']));
        var popC = safeNumber(getPath(resources, ['colony', 'colonists', 'cap']));
        var workerCap = safeNumber(getPath(resources, ['colony', 'workers', 'cap']));
        var workerFree = safeNumber(getPath(resources, ['colony', 'workers', 'value']));
        var out = { pop: popV, popCap: popC, workerCap: workerCap, workerFree: workerFree, buildings: [], res: {} };

        // Keep these keys observable even if no building currently produces them.
        var producedSet = {};
        producedSet['colony:colonists'] = true;
        producedSet['colony:androids'] = true;
        producedSet['special:spaceships'] = true;

        for (var key in collection) {
          var b = collection[key];
          if (!b) continue;
          var effNeed = effectiveWorkerNeed(b);
          if (!(effNeed > 0)) continue;

          var prodKeys = collectProducedKeys(b);
          for (var i = 0; i < prodKeys.length; i++) producedSet[prodKeys[i]] = true;

          out.buildings.push({
            key: key,
            displayName: (b.displayName || b.name || key),
            category: (b.category || ''),
            unlocked: !!b.unlocked,
            effNeed: effNeed,
            autoBuildEnabled: !!b.autoBuildEnabled,
            autoBuildBasis: String(b.autoBuildBasis || 'population'),
            autoBuildPercent: safeNumber(b.autoBuildPercent),
            autoActiveEnabled: !!b.autoActiveEnabled,
            count: safeNumber(b.count),
            active: safeNumber(b.active),
            targetCount: computeTargetCount(b, popV, workerCap, collection),
            produces: prodKeys,
            hasExternalInputs: hasExternalInputs(b)
          });
        }

        for (var rk in producedSet) {
          if (!producedSet[rk]) continue;
          var parts = rk.split(':');
          var st = getResState(resources, parts[0], parts[1]);
          if (st) out.res[rk] = st;
        }

        out.buildings.sort(function (a, b) {
          var c = String(a.category || '').localeCompare(String(b.category || ''));
          if (c) return c;
          return String(a.displayName || '').localeCompare(String(b.displayName || ''));
        });

        return out;
      },
      apply: function (updates) {
        try {
          var collection = getPageProp('buildings') || {};
          for (var key in updates) {
            var u = updates[key];
            var b = collection[key];
            if (!b || !u) continue;
            b.autoBuildBasis = 'workers';
            b.autoBuildEnabled = true;
            b.autoActiveEnabled = true;
            if (u.hasOwnProperty('autoBuildPercent')) {
              var v = Number(u.autoBuildPercent);
              if (isFinite(v)) b.autoBuildPercent = v;
            }
          }
          return { ok: true };
        } catch (e) { return { ok: false, error: String(e) }; }
      }
    };

    return __DIRECT_API__;
  }

  function getApi() {
    var injected = getPageProp('__TT_WORKER_ALLOC__');
    if (injected) return injected;
    var d = getDirectApi();
    if (d && typeof d.ready === 'function' && d.ready()) return d;
    return null;
  }

  // Page-context bridge (best compatibility path).
  function injectBridge() {
    if (getApi()) return;

    var code = ""
      + "(function(){\n"
      + "  if (window.__TT_WORKER_ALLOC__) return;\n"
      + "  function safeNumber(x){ return (typeof x==='number' && isFinite(x)) ? x : 0; }\n"
      + "  function getPath(root, path){ try{ var cur=root; for(var i=0;i<path.length;i++){ if(!cur) return undefined; cur=cur[path[i]]; } return cur; }catch(e){ return undefined; } }\n"
      + "  function effectiveWorkerNeed(b){ try{ var base=0; if(b && typeof b.getTotalWorkerNeed==='function') base=safeNumber(b.getTotalWorkerNeed()); else base=safeNumber(b?b.requiresWorker:0); var mult=1; if(b && typeof b.getEffectiveWorkerMultiplier==='function') mult=safeNumber(b.getEffectiveWorkerMultiplier()); if(!mult) mult=1; return base*mult; }catch(e){ return 0; } }\n"
      + "  function computeTargetCount(b,pop,workerCap,collection){ try{ var basis=String((b&&b.autoBuildBasis)?b.autoBuildBasis:'population'); if(basis==='max') return Infinity; var base=0; if(b && typeof b.getAutoBuildBase==='function') base=safeNumber(b.getAutoBuildBase(pop,workerCap,collection)); else base=(basis==='workers')?safeNumber(workerCap):safeNumber(pop); var pct=safeNumber(b?b.autoBuildPercent:0); return Math.ceil((pct*safeNumber(base))/100); }catch(e){ return 0; } }\n"
      + "  function isNonZeroConsumptionEntry(v){ if(v==null) return false; if(typeof v==='number') return v!==0; if(typeof v==='object'){ if(typeof v.amount==='number') return v.amount!==0; for(var k in v){ if(typeof v[k]==='number' && v[k]!==0) return true; } } return false; }\n"
      + "  function collectProducedKeys(b){ var out=[]; var prod=b&&b.production?b.production:{}; for(var cat in prod){ if(cat!=='colony' && cat!=='special') continue; var obj=prod[cat]; if(!obj||typeof obj!=='object') continue; for(var res in obj){ out.push(cat+':'+res); } } return out; }\n"
      + "  function hasExternalInputs(b){ var cons=b&&b.consumption?b.consumption:{}; for(var cat in cons){ if(cat==='colony'||cat==='special') continue; var obj=cons[cat]; if(!obj||typeof obj!=='object') continue; for(var res in obj){ if(isNonZeroConsumptionEntry(obj[res])) return true; } } return false; }\n"
      + "  function getResState(cat,res){ try{ var r=resources&&resources[cat]?resources[cat][res]:null; if(!r) return null; var prod=safeNumber(r.productionRate); var cons=safeNumber(r.consumptionRate); return { value:safeNumber(r.value), cap:safeNumber(r.cap), prod:prod, cons:cons, net:prod-cons, overflow:safeNumber(r.overflowRate), unlocked:!!r.unlocked }; }catch(e){ return null; } }\n"
      + "  window.__TT_WORKER_ALLOC__={\n"
      + "    ready:function(){ try{ return (typeof buildings!=='undefined')&&(typeof resources!=='undefined')&&resources&&resources.colony&&resources.colony.workers; }catch(e){ return false; } },\n"
      + "    snapshot:function(){\n"
      + "      var popV=safeNumber(getPath(resources,['colony','colonists','value']));\n"
      + "      var popC=safeNumber(getPath(resources,['colony','colonists','cap']));\n"
      + "      var workerCap=safeNumber(getPath(resources,['colony','workers','cap']));\n"
      + "      var workerFree=safeNumber(getPath(resources,['colony','workers','value']));\n"
      + "      var out={ pop:popV, popCap:popC, workerCap:workerCap, workerFree:workerFree, buildings:[], res:{} };\n"
      + "      var producedSet={}; producedSet['colony:colonists']=true; producedSet['colony:androids']=true; producedSet['special:spaceships']=true;\n"
      + "      var collection=(typeof buildings!=='undefined')?buildings:{};\n"
      + "      for(var key in collection){ var b=collection[key]; if(!b) continue; var eff=effectiveWorkerNeed(b); if(!(eff>0)) continue;\n"
      + "        var prodKeys=collectProducedKeys(b); for(var i=0;i<prodKeys.length;i++){ producedSet[prodKeys[i]]=true; }\n"
      + "        out.buildings.push({ key:key, displayName:(b.displayName||b.name||key), category:(b.category||''), unlocked:!!b.unlocked, effNeed:eff,\n"
      + "          autoBuildEnabled:!!b.autoBuildEnabled, autoBuildBasis:String(b.autoBuildBasis||'population'), autoBuildPercent:safeNumber(b.autoBuildPercent), autoActiveEnabled:!!b.autoActiveEnabled,\n"
      + "          count:safeNumber(b.count), active:safeNumber(b.active), targetCount:computeTargetCount(b,popV,workerCap,collection), produces:prodKeys, hasExternalInputs:hasExternalInputs(b) }); }\n"
      + "      for(var rk in producedSet){ if(!producedSet[rk]) continue; var parts=rk.split(':'); var st=getResState(parts[0],parts[1]); if(st) out.res[rk]=st; }\n"
      + "      out.buildings.sort(function(a,b){ var c=String(a.category||'').localeCompare(String(b.category||'')); if(c) return c; return String(a.displayName||'').localeCompare(String(b.displayName||'')); });\n"
      + "      return out; },\n"
      + "    apply:function(updates){ try{ var collection=(typeof buildings!=='undefined')?buildings:{}; for(var key in updates){ var u=updates[key]; var b=collection[key]; if(!b||!u) continue;\n"
      + "        b.autoBuildBasis='workers'; b.autoBuildEnabled=true; b.autoActiveEnabled=true; if(u.hasOwnProperty('autoBuildPercent')){ var v=Number(u.autoBuildPercent); if(isFinite(v)) b.autoBuildPercent=v; } }\n"
      + "      return {ok:true}; }catch(e){ return {ok:false,error:String(e)}; } }\n"
      + "  };\n"
      + "})();\n";

    var s = document.createElement('script');
    s.textContent = code;
    document.documentElement.appendChild(s);
    s.parentNode.removeChild(s);
  }

  // ---------------- storage (GM fallback to localStorage) ----------------
  var STORE_KEY = 'ttwa465__';
  var hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

  function getVal(key, def) {
    try {
      if (hasGM) return GM_getValue(key, def);
      var raw = localStorage.getItem(STORE_KEY + key);
      return (raw == null) ? def : JSON.parse(raw);
    } catch (e) { return def; }
  }
  function setVal(key, val) {
    try {
      if (hasGM) return GM_setValue(key, val);
      localStorage.setItem(STORE_KEY + key, JSON.stringify(val));
    } catch (e) {}
  }

  // ---------------- small utils ----------------
  var SUFFIX_FMT = [[1e24,'Y'],[1e21,'Z'],[1e18,'E'],[1e15,'P'],[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']];
  function fmtNum(x) {
    if (!Number.isFinite(x)) return String(x);
    var ax = Math.abs(x);
    for (var i = 0; i < SUFFIX_FMT.length; i++) {
      var v = SUFFIX_FMT[i][0], s = SUFFIX_FMT[i][1];
      if (ax >= v) {
        var d = (ax >= v * 100) ? 0 : (ax >= v * 10) ? 1 : 2;
        return (x / v).toFixed(d) + s;
      }
    }
    if (ax >= 100) return x.toFixed(0);
    if (ax >= 10) return x.toFixed(1);
    if (ax >= 1) return x.toFixed(2);
    if (ax === 0) return '0';
    return x.toExponential(3);
  }
  function fmtPct(x) {
    if (!Number.isFinite(x)) return '';
    var ax = Math.abs(x);
    if (ax === 0) return '0';
    if (ax >= 10) return x.toFixed(3);
    if (ax >= 1) return x.toFixed(4);
    if (ax >= 0.01) return x.toFixed(6);
    return x.toExponential(6);
  }
  function clamp(x, a, b) {
    var n = Number(x);
    if (!Number.isFinite(n)) return a;
    return Math.max(a, Math.min(b, n));
  }
  function toNum(x, d) {
    var n = Number(x);
    return Number.isFinite(n) ? n : (d || 0);
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  // ---------------- settings/state ----------------
  var DEFAULTS = {
    running: false,
    minimized: false,

    showOnlyUnlocked: true,

    // Min toggles + floor strengths (% of remainder, deficit-scaled)
    keepClonesMin: true,
    keepAndroidsMin: true,
    keepShipsMin: false,
    keepBiodomesMin: false,

    minPctClones: 2,
    minPctAndroids: 2,
    minPctShips: 1,
    minPctBiodomes: 1,

    // safeguard / buffer model
    preferNetZero: true,
    bufferSeconds: 30,
    softHorizonSeconds: 600,
    refillSeconds: 60,
    strengthenBand: 2.0,

    // pop cap maintenance
    capFillSeconds: 45,       // target time constant for filling cap deficits (even if cons==0)
    popCapBandFrac: 0.002,    // deficit fraction that maps to "full" severity (0.2% under cap -> sev=1)
    popCapHystOn: 0.99999,
    popCapHystOff: 0.99950,
    popConsMarginFrac: 0.002, // if consumption>0, request a small positive margin

    // Max/Learn
    maxBuildingKey: null,
    maxResKey: null,
    learnAgg: 35,           // 0..100
    learnSmooth: 60,        // 0..100 (higher = more volatility penalty)
    learnIntervalSec: 8,    // 3..60
    learnSettleSec: 8       // 3..60
  };

  var state = (function () {
    var s = getVal('settings', DEFAULTS);
    var out = {};
    for (var k in DEFAULTS) out[k] = DEFAULTS[k];
    for (var k2 in s) out[k2] = s[k2];
    return out;
  })();

  var rowState = getVal('rows', {});                 // key -> { enabled:boolean, weight:number }
  var boostPctByKey = getVal('boostPctByKey', {});   // key -> boost % of remainder workers reserved

  function saveSettings() { setVal('settings', state); }
  function saveRows() { setVal('rows', rowState); }
  function saveBoosts() { setVal('boostPctByKey', boostPctByKey); }

  // ---------------- UI ----------------
  function addStyle(css) {
    var s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  // Visually distinct from game dark mode: slightly tinted background + higher-contrast border + stronger shadow.
  addStyle(
    "#ttwa-root{position:fixed;top:88px;right:16px;z-index:999999;font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;color:#eaeaf0}" +
    "#ttwa-root *{box-sizing:border-box}" +
    "#ttwa-panel{width:var(--ttwa-w,940px);max-width:calc(100vw - 24px);background:linear-gradient(180deg, rgba(38,32,55,.96) 0%, rgba(20,18,28,.96) 80%);border:1px solid rgba(140,200,255,.36);border-radius:14px;box-shadow:0 22px 70px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.06) inset;overflow:hidden;backdrop-filter:blur(7px);user-select:none;display:flex;flex-direction:column;resize:horizontal}" +
    "#ttwa-header{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.10);cursor:move;background:rgba(0,0,0,.14)}" +
    "#ttwa-title{font-weight:850;font-size:13px;letter-spacing:.25px}" +
    "#ttwa-spacer{flex:1}" +
    ".ttwa-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eaeaf0;border-radius:10px;padding:6px 10px;cursor:pointer}" +
    ".ttwa-btn:hover{background:rgba(255,255,255,.14)}" +
    ".ttwa-btn:active{transform:translateY(1px)}" +
    ".ttwa-btn.primary{background:rgba(140,200,255,.18);border-color:rgba(140,200,255,.42)}" +
    ".ttwa-btn.primary:hover{background:rgba(140,200,255,.26)}" +
    ".ttwa-btn.small{padding:5px 9px;border-radius:10px}" +
    ".ttwa-toggle{border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.20);color:#eaeaf0;border-radius:10px;padding:6px 10px;cursor:pointer}" +
    ".ttwa-toggle.on{background:rgba(140,200,255,.22);border-color:rgba(140,200,255,.48)}" +
    ".ttwa-toggle:hover{background:rgba(255,255,255,.10)}" +
    ".ttwa-toggle.on:hover{background:rgba(140,200,255,.30)}" +
    ".ttwa-mini{opacity:.78;font-size:11px}" +
    ".ttwa-muted{opacity:.72}" +
    ".ttwa-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
    ".ttwa-input{padding:6px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.24);color:#eaeaf0;outline:none}" +
    ".ttwa-input:focus{border-color:rgba(140,200,255,.55)}" +
    ".ttwa-badge{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.16);font-size:11px;white-space:nowrap}" +
    "#ttwa-body{padding:10px 12px;display:flex;flex-direction:column;gap:10px;overflow:hidden}" +
    ".ttwa-card{border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:10px;background:rgba(0,0,0,.18)}" +
    ".ttwa-grid{display:grid;grid-template-columns:1fr 1fr;gap:8px}" +
    ".ttwa-kv{display:flex;flex-direction:column;gap:4px}" +
    ".ttwa-kv .k{opacity:.75;font-size:11px}" +
    ".ttwa-kv .v{display:flex;gap:8px;align-items:center;flex-wrap:wrap}" +
    ".ttwa-tablewrap{overflow:auto;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.10)}" +
    "table.ttwa-table{width:100%;border-collapse:collapse;table-layout:fixed}" +
    ".ttwa-table th,.ttwa-table td{padding:7px 7px;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:middle}" +
    ".ttwa-table th{font-weight:850;background:rgba(0,0,0,.18);position:sticky;top:0;z-index:2}" +
    ".ttwa-right{text-align:right}" +
    ".ttwa-center{text-align:center}" +
    ".ttwa-bname{font-weight:850;white-space:normal;overflow-wrap:anywhere}" +
    ".ttwa-weight{width:86px;text-align:right}" +
    ".ttwa-info{display:inline-flex;align-items:center;justify-content:center;width:18px;height:18px;border-radius:999px;border:1px solid rgba(255,255,255,.20);background:rgba(0,0,0,.18);color:#eaeaf0;font-weight:900;font-size:11px;cursor:help;margin-left:8px;flex:0 0 auto}" +
    ".ttwa-info:hover{background:rgba(140,200,255,.22);border-color:rgba(140,200,255,.45)}" +
    ".ttwa-bar{position:relative;height:18px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.22);overflow:hidden}" +
    ".ttwa-barfill{position:absolute;left:0;top:0;bottom:0;background:linear-gradient(90deg, rgba(140,200,255,.20), rgba(140,200,255,.38))}" +
    ".ttwa-bartext{position:relative;z-index:1;display:flex;align-items:center;justify-content:center;height:100%;font:11px/1 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace;color:#f1f1ff;white-space:nowrap;text-shadow:0 1px 0 rgba(0,0,0,.55)}" +
    "#ttwa-tip{position:fixed;z-index:1000000;display:none;max-width:420px;background:rgba(14,14,18,.96);border:1px solid rgba(140,200,255,.38);border-radius:12px;box-shadow:0 14px 45px rgba(0,0,0,.62);padding:10px;pointer-events:none;color:#f3f3ff}" +
    "#ttwa-tip .tt{font-weight:900;margin-bottom:6px}" +
    "#ttwa-tip .ln{display:flex;gap:10px;justify-content:space-between;align-items:flex-start;line-height:1.25}" +
    "#ttwa-tip .lk{opacity:.78;white-space:nowrap}" +
    "#ttwa-tip .lv{opacity:.95;text-align:right;white-space:normal;overflow-wrap:anywhere}"
  );

  function el(tag, attrs, children) {
    var e = document.createElement(tag);
    attrs = attrs || {};
    children = children || [];
    for (var k in attrs) {
      if (!attrs.hasOwnProperty(k)) continue;
      var v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.indexOf('on') === 0 && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (var i = 0; i < children.length; i++) e.appendChild(children[i]);
    return e;
  }

  // Tooltip: single component, per-node HTML set via property __ttwaTipHtml.
  var tip = null;
  function showTip(html, x, y) {
    if (!tip) return;
    tip.innerHTML = html;
    tip.style.display = 'block';

    var pad = 12;
    var vw = window.innerWidth || 0;
    var vh = window.innerHeight || 0;

    // Place near cursor but clamp within viewport.
    var tx = x + 14;
    var ty = y + 14;

    // Need measure after display.
    var r = tip.getBoundingClientRect();
    if (tx + r.width + pad > vw) tx = Math.max(pad, vw - r.width - pad);
    if (ty + r.height + pad > vh) ty = Math.max(pad, y - r.height - 14);
    if (ty < pad) ty = pad;

    tip.style.left = tx + 'px';
    tip.style.top = ty + 'px';
  }
  function hideTip() {
    if (!tip) return;
    tip.style.display = 'none';
  }
  function wireTip(node) {
    if (!node || node.__ttwaTipWired) return;
    node.__ttwaTipWired = true;

    node.addEventListener('mouseenter', function (e) {
      if (!node.__ttwaTipHtml) return;
      showTip(node.__ttwaTipHtml, e.clientX, e.clientY);
    });
    node.addEventListener('mousemove', function (e) {
      if (!node.__ttwaTipHtml) return;
      showTip(node.__ttwaTipHtml, e.clientX, e.clientY);
    });
    node.addEventListener('mouseleave', function () { hideTip(); });
  }
  function setTip(node, html) {
    if (!node) return;
    node.__ttwaTipHtml = html;
    wireTip(node);
  }

  // ---------------- position guardrails + drag ----------------
  function clampRootToViewport(root) {
    if (!root) return;
    var vw = window.innerWidth || document.documentElement.clientWidth || 0;
    var vh = window.innerHeight || document.documentElement.clientHeight || 0;
    if (!vw || !vh) return;

    var r = root.getBoundingClientRect();
    var w = r.width || 0;
    var h = r.height || 0;
    if (!w || !h) return;

    var header = root.querySelector('#ttwa-header');
    var headerH = 42;
    if (header && header.getBoundingClientRect) {
      var hr = header.getBoundingClientRect();
      if (hr && hr.height) headerH = hr.height;
    }

    var minVisibleX = 56;
    var minVisibleY = Math.max(28, Math.min(60, headerH));

    var minLeft = -w + minVisibleX;
    var maxLeft = vw - minVisibleX;
    var minTop = -h + minVisibleY;
    var maxTop = vh - minVisibleY;

    function clamp2(v, a, b) { return Math.min(Math.max(v, a), b); }

    var left = clamp2(r.left, minLeft, maxLeft);
    var top = clamp2(r.top, minTop, maxTop);

    if (Math.abs(left - r.left) < 0.5 && Math.abs(top - r.top) < 0.5) return;

    root.style.left = left + 'px';
    root.style.top = top + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    savePosFrom(root);
  }

  function loadPosInto(root) {
    try {
      var p = getVal('pos', null);
      if (p && typeof p.left === 'number' && typeof p.top === 'number') {
        root.style.left = p.left + 'px';
        root.style.top = p.top + 'px';
        root.style.right = 'auto';
      }
    } catch (e) {}
    clampRootToViewport(root);
  }

  function savePosFrom(root) {
    try {
      var r = root.getBoundingClientRect();
      setVal('pos', { left: Math.round(r.left), top: Math.round(r.top) });
    } catch (e) {}
  }

  function resetPos(root) {
    try { setVal('pos', null); } catch (e) {}
    root.style.left = '';
    root.style.right = '16px';
    root.style.top = '88px';
    clampRootToViewport(root);
  }

  function enableDrag(root, handle) {
    var dragging = false;
    var pid = null;
    var sx = 0, sy = 0, ox = 0, oy = 0;

    function isInteractiveTarget(t) {
      try { return !!(t && t.closest && t.closest('button, input, select, textarea, a, label')); }
      catch (e) { return false; }
    }

    handle.addEventListener('pointerdown', function (e) {
      if (e.button !== 0) return;
      if (isInteractiveTarget(e.target)) return;

      dragging = true;
      pid = e.pointerId;

      var r = root.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      ox = r.left; oy = r.top;

      root.style.left = ox + 'px';
      root.style.top = oy + 'px';
      root.style.right = 'auto';

      if (handle.setPointerCapture) {
        try { handle.setPointerCapture(pid); } catch (err) {}
      }
      e.preventDefault();
    });

    window.addEventListener('pointermove', function (e) {
      if (!dragging) return;
      if (pid != null && e.pointerId !== pid) return;

      root.style.left = (ox + (e.clientX - sx)) + 'px';
      root.style.top = (oy + (e.clientY - sy)) + 'px';
      root.style.right = 'auto';
      clampRootToViewport(root);
    });

    window.addEventListener('pointerup', function (e) {
      if (!dragging) return;
      if (pid != null && e.pointerId !== pid) return;
      dragging = false;
      pid = null;
      clampRootToViewport(root);
      savePosFrom(root);
    });
  }

  // ---------------- UI build ----------------
  var ui = {};
  function buildUI() {
    ui.root = el('div', { id: 'ttwa-root' });
    ui.panel = el('div', { id: 'ttwa-panel' });

    tip = el('div', { id: 'ttwa-tip' });
    ui.root.appendChild(tip);

    ui.runBtn = el('button', { class: 'ttwa-btn primary', text: state.running ? 'Stop' : 'Start' });
    ui.minBtn = el('button', { class: 'ttwa-btn small', text: state.minimized ? '▢' : '—' });

    ui.header = el('div', { id: 'ttwa-header' }, [
      el('div', { id: 'ttwa-title', text: 'TT Worker Allocator' }),
      el('div', { id: 'ttwa-spacer' }),
      ui.runBtn,
      ui.minBtn
    ]);

    ui.body = el('div', { id: 'ttwa-body' });
    ui.statusCard = el('div', { class: 'ttwa-card' });
    ui.allocCard = el('div', { class: 'ttwa-card' });

    ui.body.appendChild(ui.statusCard);
    ui.body.appendChild(ui.allocCard);

    ui.panel.appendChild(ui.header);
    ui.panel.appendChild(ui.body);
    ui.root.appendChild(ui.panel);
    document.body.appendChild(ui.root);

    loadPosInto(ui.root);
    enableDrag(ui.root, ui.header);

    ui.header.addEventListener('dblclick', function (e) {
      if (e && e.target && e.target.closest && e.target.closest('button, input, select, textarea, a, label')) return;
      resetPos(ui.root);
    });

    window.addEventListener('resize', function () { clampRootToViewport(ui.root); });

    ui.runBtn.addEventListener('click', function () {
      state.running = !state.running;
      ui.runBtn.textContent = state.running ? 'Stop' : 'Start';
      saveSettings();
    });

    ui.minBtn.addEventListener('click', function () {
      state.minimized = !state.minimized;
      ui.minBtn.textContent = state.minimized ? '▢' : '—';
      ui.body.style.display = state.minimized ? 'none' : 'flex';
      saveSettings();
      clampRootToViewport(ui.root);
    });

    ui.body.style.display = state.minimized ? 'none' : 'flex';

    setTip(ui.runBtn,
      '<div class="tt">Start / Stop</div>' +
      '<div class="ln"><div class="lk">Effect</div><div class="lv">When <b>Start</b> is on, this script writes <code>autoBuildPercent</code> into worker-basis buildings every tick.</div></div>' +
      '<div class="ln"><div class="lk">Safety</div><div class="lv">Stops immediately if bridge apply() fails.</div></div>'
    );

    setTip(ui.minBtn,
      '<div class="tt">Minimize</div>' +
      '<div class="ln"><div class="lk">Effect</div><div class="lv">Collapses the overlay to the header (no allocation changes).</div></div>' +
      '<div class="ln"><div class="lk">Tip</div><div class="lv">Double-click the header to reset position.</div></div>'
    );
  }

  // ---------------- building helpers ----------------
  function isWorkersBasis(b) { return String(b && b.autoBuildBasis ? b.autoBuildBasis : '') === 'workers'; }
  function hasWorkers(b) { return toNum(b && b.effNeed, 0) > 0; }

  function getFixedBuildings(snapshot) {
    var out = [];
    for (var i = 0; i < snapshot.buildings.length; i++) {
      var b = snapshot.buildings[i];
      if (hasWorkers(b) && !isWorkersBasis(b)) out.push(b);
    }
    return out;
  }
  function getAllocBuildings(snapshot) {
    var out = [];
    for (var i = 0; i < snapshot.buildings.length; i++) {
      var b = snapshot.buildings[i];
      if (!hasWorkers(b)) continue;
      if (!isWorkersBasis(b)) continue;
      if (state.showOnlyUnlocked && !b.unlocked) continue;
      out.push(b);
    }
    return out;
  }
  function findBuildingKeyByName(snapshot, re) {
    for (var i = 0; i < snapshot.buildings.length; i++) {
      var x = snapshot.buildings[i];
      if (re.test(x.key) || re.test(x.displayName)) return x.key;
    }
    return null;
  }

  // ---------------- resource filters ----------------
  function isExcludedForSafeguards(resKey) {
    // Must not attempt to stabilize these; they are system-level / non-buffered.
    var r = String(resKey || '').split(':')[1] || '';
    return (r === 'energy' || r === 'workers' || r === 'funding');
  }
  function isExcludedForMax(resKey) {
    // Avoid learning against caps/system resources.
    var r = String(resKey || '').split(':')[1] || '';
    return (r === 'energy' || r === 'workers' || r === 'funding' || r === 'colonists');
  }
  function isPopRes(resKey) {
    return resKey === 'colony:colonists' || resKey === 'colony:androids';
  }
  function resKeyLabel(rk) {
    var parts = String(rk || '').split(':');
    return parts.length >= 2 ? parts[1] : String(rk || '');
  }

  // ---------------- row state sync ----------------
  var lastKeysSig = '';
  function hydrateRowDefaults(snapshot) {
    var workerCap = toNum(snapshot.workerCap, 0);
    var fixed = getFixedBuildings(snapshot);
    var fixedWorkers = 0;
    for (var i = 0; i < fixed.length; i++) {
      var b = fixed[i];
      var count = b.autoBuildEnabled ? (Number.isFinite(b.targetCount) ? b.targetCount : 0) : toNum(b.active, 0);
      fixedWorkers += count * toNum(b.effNeed, 0);
    }
    var remainder = Math.max(0, workerCap - fixedWorkers);
    var alloc = getAllocBuildings(snapshot);

    var changed = false;
    for (var j = 0; j < alloc.length; j++) {
      var bb = alloc[j];
      if (!rowState[bb.key]) rowState[bb.key] = {};
      if (rowState[bb.key].enabled === undefined) { rowState[bb.key].enabled = true; changed = true; }
      if (rowState[bb.key].weight === undefined) {
        var curCount = bb.autoBuildEnabled ? (Number.isFinite(bb.targetCount) ? bb.targetCount : 0) : toNum(bb.active, 0);
        var curWorkers = curCount * toNum(bb.effNeed, 0);
        var share = remainder > 0 ? (curWorkers / remainder) * 100 : 0;
        rowState[bb.key].weight = Number.isFinite(share) ? Math.max(0, Math.round(share * 10) / 10) : 0;
        changed = true;
      }
    }
    if (changed) saveRows();
  }

  function pickMaxResKeyFromBuilding(b) {
    try {
      var pr = (b && b.produces) ? b.produces : [];
      for (var i = 0; i < pr.length; i++) {
        var rk = pr[i];
        if (!rk) continue;
        if (isExcludedForMax(rk)) continue;
        return rk;
      }
    } catch (e) {}
    return null;
  }

  function ensureRows(snapshot) {
    var alloc = getAllocBuildings(snapshot);
    var keys = [];
    for (var i = 0; i < alloc.length; i++) keys.push(alloc[i].key);
    var sig = keys.join('|');
    if (sig === lastKeysSig) return;
    lastKeysSig = sig;

    hydrateRowDefaults(snapshot);

    // if selected max building vanished, clear
    if (state.maxBuildingKey) {
      var ok = false;
      for (var mi = 0; mi < alloc.length; mi++) if (alloc[mi].key === state.maxBuildingKey) { ok = true; break; }
      if (!ok) { state.maxBuildingKey = null; state.maxResKey = null; saveSettings(); }
    }

    // Controls + table
    var rowsHtml = '';
    for (var r = 0; r < alloc.length; r++) {
      var b = alloc[r];
      var maxrk = pickMaxResKeyFromBuilding(b);

      rowsHtml += ''
        + '<tr data-key="' + escapeHtml(b.key) + '" data-maxrk="' + escapeHtml(maxrk || '') + '">'
        + '  <td class="ttwa-center"><input class="ttwa-use" type="checkbox"></td>'
        + '  <td class="ttwa-center"><input class="ttwa-max" type="checkbox"></td>'
        + '  <td>'
        + '    <div style="display:flex;align-items:center;gap:8px">'
        + '      <div class="ttwa-bname" title="' + escapeHtml(b.displayName) + '">' + escapeHtml(b.displayName) + '</div>'
        + '      <button class="ttwa-info" type="button">i</button>'
        + '    </div>'
        + '  </td>'
        + '  <td class="ttwa-right"><input class="ttwa-input ttwa-weight" type="number" step="0.1" min="0"></td>'
        + '  <td><div class="ttwa-bar"><div class="ttwa-barfill" style="width:0%"></div><div class="ttwa-bartext">0</div></div></td>'
        + '</tr>';
    }

    ui.allocCard.innerHTML = ''
      + '<div class="ttwa-row" style="justify-content:space-between;align-items:flex-end;gap:12px">'
      + '  <div>'
      + '    <div style="font-weight:900">Allocation</div>'
      + '    <div class="ttwa-mini ttwa-muted">Weights distribute workers <b>after</b> fixed demand + floors. Safeguards add reserve floors. <b>Max</b> learns weights to maximize one selected output.</div>'
      + '  </div>'
      + '</div>'
      + '<div class="ttwa-row" style="margin-top:10px;gap:10px;align-items:center">'
      + '  <span class="ttwa-mini ttwa-muted">Minimum floors:</span>'
      + '  <button id="ttwa-minClones" class="ttwa-toggle">Min Clones</button>'
      + '  <input id="ttwa-minClonesPct" class="ttwa-input" type="number" min="0" max="10" step="0.1" style="width:64px"><span class="ttwa-mini ttwa-muted">%</span>'
      + '  <button id="ttwa-minAndroids" class="ttwa-toggle">Min Androids</button>'
      + '  <input id="ttwa-minAndroidsPct" class="ttwa-input" type="number" min="0" max="10" step="0.1" style="width:64px"><span class="ttwa-mini ttwa-muted">%</span>'
      + '  <button id="ttwa-minShips" class="ttwa-toggle">Min Ships</button>'
      + '  <input id="ttwa-minShipsPct" class="ttwa-input" type="number" min="0" max="10" step="0.1" style="width:64px"><span class="ttwa-mini ttwa-muted">%</span>'
      + '  <button id="ttwa-minBiodomes" class="ttwa-toggle">Min Biodomes</button>'
      + '  <input id="ttwa-minBiodomesPct" class="ttwa-input" type="number" min="0" max="10" step="0.1" style="width:64px"><span class="ttwa-mini ttwa-muted">%</span>'
      + '</div>'
      + '<div class="ttwa-row" style="margin-top:8px;gap:12px;align-items:center">'
      + '  <span class="ttwa-mini ttwa-muted">Learn:</span>'
      + '  <span class="ttwa-mini ttwa-muted">Agg</span>'
      + '  <input id="ttwa-learnAgg" type="range" min="0" max="100" step="1" style="width:160px">'
      + '  <span class="ttwa-badge" id="ttwa-learnAggVal"></span>'
      + '  <span class="ttwa-mini ttwa-muted">Smooth</span>'
      + '  <input id="ttwa-learnSmooth" type="range" min="0" max="100" step="1" style="width:160px">'
      + '  <span class="ttwa-badge" id="ttwa-learnSmoothVal"></span>'
      + '  <span class="ttwa-mini ttwa-muted">Step</span>'
      + '  <input id="ttwa-learnInterval" class="ttwa-input" type="number" min="3" max="60" step="1" style="width:70px">'
      + '  <span class="ttwa-mini ttwa-muted">s</span>'
      + '  <span class="ttwa-mini ttwa-muted">Settle</span>'
      + '  <input id="ttwa-learnSettle" class="ttwa-input" type="number" min="3" max="60" step="1" style="width:70px">'
      + '  <span class="ttwa-mini ttwa-muted">s</span>'
      + '  <button id="ttwa-resetlearn" class="ttwa-btn small">Reset Learner</button>'
      + '</div>'
      + '<div style="margin-top:10px" class="ttwa-tablewrap">'
      + '  <table class="ttwa-table">'
      + '    <colgroup>'
      + '      <col style="width:46px">'
      + '      <col style="width:46px">'
      + '      <col>'
      + '      <col style="width:104px">'
      + '      <col style="width:250px">'
      + '    </colgroup>'
      + '    <thead>'
      + '      <tr>'
      + '        <th class="ttwa-center">Use</th>'
      + '        <th class="ttwa-center">Max</th>'
      + '        <th>Building</th>'
      + '        <th class="ttwa-right">Weight</th>'
      + '        <th>Workers</th>'
      + '      </tr>'
      + '    </thead>'
      + '    <tbody>' + (rowsHtml || '<tr><td colspan="5" class="ttwa-muted">No worker-basis buildings detected yet.</td></tr>') + '</tbody>'
      + '  </table>'
      + '</div>';

    // Wire controls (unchanged from your version)
    var minClonesBtn = ui.allocCard.querySelector('#ttwa-minClones');
    var minAndroidsBtn = ui.allocCard.querySelector('#ttwa-minAndroids');
    var minShipsBtn = ui.allocCard.querySelector('#ttwa-minShips');
    var minBiodomesBtn = ui.allocCard.querySelector('#ttwa-minBiodomes');

    var minClonesPct = ui.allocCard.querySelector('#ttwa-minClonesPct');
    var minAndroidsPct = ui.allocCard.querySelector('#ttwa-minAndroidsPct');
    var minShipsPct = ui.allocCard.querySelector('#ttwa-minShipsPct');
    var minBiodomesPct = ui.allocCard.querySelector('#ttwa-minBiodomesPct');

    function syncMinUI() {
      minClonesBtn.classList.toggle('on', !!state.keepClonesMin);
      minAndroidsBtn.classList.toggle('on', !!state.keepAndroidsMin);
      minShipsBtn.classList.toggle('on', !!state.keepShipsMin);
      minBiodomesBtn.classList.toggle('on', !!state.keepBiodomesMin);

      minClonesPct.value = String(clamp(toNum(state.minPctClones, 2), 0, 10));
      minAndroidsPct.value = String(clamp(toNum(state.minPctAndroids, 2), 0, 10));
      minShipsPct.value = String(clamp(toNum(state.minPctShips, 1), 0, 10));
      minBiodomesPct.value = String(clamp(toNum(state.minPctBiodomes, 1), 0, 10));
    }
    syncMinUI();

    function tipMin(label, which) {
      return '<div class="tt">' + escapeHtml(label) + '</div>'
        + '<div class="ln"><div class="lk">What</div><div class="lv">Reserves a <b>minimum</b> share of the remainder for the matching building.</div></div>'
        + '<div class="ln"><div class="lk">Strength</div><div class="lv">The % is multiplied by a <b>deficit factor</b> (strong when under cap, fades near cap).</div></div>'
        + '<div class="ln"><div class="lk">Why</div><div class="lv">Prevents the allocator from starving critical progression buildings while other safeguards compete.</div></div>'
        + '<div class="ln"><div class="lk">Key</div><div class="lv"><code>' + escapeHtml(which) + '</code></div></div>';
    }
    setTip(minClonesBtn, tipMin('Min Clones', 'clone building'));
    setTip(minAndroidsBtn, tipMin('Min Androids', 'android building'));
    setTip(minShipsBtn, tipMin('Min Ships', 'shipyard'));
    setTip(minBiodomesBtn, tipMin('Min Biodomes', 'biodome'));

    function bindToggle(btn, key) {
      btn.addEventListener('click', function () {
        state[key] = !state[key];
        syncMinUI();
        saveSettings();
      });
    }
    bindToggle(minClonesBtn, 'keepClonesMin');
    bindToggle(minAndroidsBtn, 'keepAndroidsMin');
    bindToggle(minShipsBtn, 'keepShipsMin');
    bindToggle(minBiodomesBtn, 'keepBiodomesMin');

    function bindPct(inp, key) {
      inp.addEventListener('change', function () {
        state[key] = clamp(toNum(inp.value, state[key]), 0, 10);
        inp.value = String(state[key]);
        saveSettings();
      });
    }
    bindPct(minClonesPct, 'minPctClones');
    bindPct(minAndroidsPct, 'minPctAndroids');
    bindPct(minShipsPct, 'minPctShips');
    bindPct(minBiodomesPct, 'minPctBiodomes');

    setTip(minClonesPct, '<div class="tt">Min floor %</div><div class="ln"><div class="lk">Meaning</div><div class="lv">% of <b>remainder workers</b> reserved (before weights), scaled by cap deficit.</div></div>');
    setTip(minAndroidsPct, '<div class="tt">Min floor %</div><div class="ln"><div class="lk">Meaning</div><div class="lv">% of <b>remainder workers</b> reserved (before weights), scaled by cap deficit.</div></div>');
    setTip(minShipsPct, '<div class="tt">Min floor %</div><div class="ln"><div class="lk">Meaning</div><div class="lv">% of <b>remainder workers</b> reserved (before weights), scaled by cap deficit.</div></div>');
    setTip(minBiodomesPct, '<div class="tt">Min floor %</div><div class="ln"><div class="lk">Meaning</div><div class="lv">% of <b>remainder workers</b> reserved (before weights), scaled by cap deficit.</div></div>');

    var resetBtn = ui.allocCard.querySelector('#ttwa-resetlearn');
    resetBtn.addEventListener('click', function () { resetMaxLearner(true); });
    setTip(resetBtn,
      '<div class="tt">Reset Learner</div>' +
      '<div class="ln"><div class="lk">Effect</div><div class="lv">Clears the learner state (observations + current trial). Does <b>not</b> change your saved weights.</div></div>'
    );

    // Learn controls
    var learnAgg = ui.allocCard.querySelector('#ttwa-learnAgg');
    var learnAggVal = ui.allocCard.querySelector('#ttwa-learnAggVal');
    var learnSmooth = ui.allocCard.querySelector('#ttwa-learnSmooth');
    var learnSmoothVal = ui.allocCard.querySelector('#ttwa-learnSmoothVal');
    var learnInterval = ui.allocCard.querySelector('#ttwa-learnInterval');
    var learnSettle = ui.allocCard.querySelector('#ttwa-learnSettle');

    learnAgg.value = String(clamp(toNum(state.learnAgg, 35), 0, 100));
    learnSmooth.value = String(clamp(toNum(state.learnSmooth, 60), 0, 100));
    learnInterval.value = String(clamp(toNum(state.learnIntervalSec, 8), 3, 60));
    learnSettle.value = String(clamp(toNum(state.learnSettleSec, 8), 3, 60));

    function refreshLearnLabels() {
      learnAggVal.textContent = String(Math.round(clamp(toNum(learnAgg.value, 35), 0, 100)));
      learnSmoothVal.textContent = String(Math.round(clamp(toNum(learnSmooth.value, 60), 0, 100)));
    }
    refreshLearnLabels();

    learnAgg.addEventListener('input', function () {
      state.learnAgg = clamp(toNum(learnAgg.value, 35), 0, 100);
      refreshLearnLabels();
      saveSettings();
    });
    learnSmooth.addEventListener('input', function () {
      state.learnSmooth = clamp(toNum(learnSmooth.value, 60), 0, 100);
      refreshLearnLabels();
      saveSettings();
    });
    learnInterval.addEventListener('change', function () {
      state.learnIntervalSec = clamp(toNum(learnInterval.value, 8), 3, 60);
      learnInterval.value = String(state.learnIntervalSec);
      saveSettings();
    });
    learnSettle.addEventListener('change', function () {
      state.learnSettleSec = clamp(toNum(learnSettle.value, 8), 3, 60);
      learnSettle.value = String(state.learnSettleSec);
      saveSettings();
    });

    // Wire row controls
    var trs = ui.allocCard.querySelectorAll('tr[data-key]');
    for (var t = 0; t < trs.length; t++) {
      (function () {
        var tr = trs[t];
        var key = tr.getAttribute('data-key');
        var cb = tr.querySelector('.ttwa-use');
        var cbMax = tr.querySelector('.ttwa-max');
        var inp = tr.querySelector('.ttwa-weight');

        if (!rowState[key]) rowState[key] = {};
        var rs = rowState[key] || {};
        cb.checked = (rs.enabled !== false);
        inp.value = String(Number.isFinite(rs.weight) ? rs.weight : 0);

        var maxrk = tr.getAttribute('data-maxrk') || '';
        cbMax.checked = (state.maxBuildingKey === key);
        cbMax.disabled = !maxrk || isExcludedForMax(maxrk);

        cb.addEventListener('change', function () {
          if (!rowState[key]) rowState[key] = {};
          rowState[key].enabled = cb.checked;
          saveRows();
          if (!cb.checked && state.maxBuildingKey === key) {
            state.maxBuildingKey = null;
            state.maxResKey = null;
            saveSettings();
            resetMaxLearner(true);
          }
        });

        cbMax.addEventListener('change', function () {
          if (cbMax.checked) {
            state.maxBuildingKey = key;
            state.maxResKey = (maxrk && !isExcludedForMax(maxrk)) ? maxrk : null;
            saveSettings();
            resetMaxLearner(true);

            var others = ui.allocCard.querySelectorAll('.ttwa-max');
            for (var i = 0; i < others.length; i++) {
              var otr = others[i].closest('tr[data-key]');
              if (!otr) continue;
              var okk = otr.getAttribute('data-key');
              if (okk !== key) others[i].checked = false;
            }
          } else {
            if (state.maxBuildingKey === key) {
              state.maxBuildingKey = null;
              state.maxResKey = null;
              saveSettings();
              resetMaxLearner(true);
            }
          }
        });

        inp.addEventListener('input', function () {
          if (!rowState[key]) rowState[key] = {};
          rowState[key].weight = toNum(inp.value, 0);
          saveRows();
        });
      })();
    }

    saveSettings();
  }

  // ---------------- safeguard model ----------------
  var rt = {
    resEma: {},         // key -> EMA(net) for smoothing error signals
    emergEma: {},       // key -> EMA(severity) for emergency floors
    lastEmergencyAt: 0,
    lastSafeguardAt: 0,
    lastApplyAt: 0,
    lastAppliedPct: {},

    capState: { android: false, colonists: false },

    maxLearn: {
      resKey: null,
      obs: [],
      mean: 0,
      mad: 0,
      lastScore: NaN,
      lastStepAt: 0,
      trial: null,
      paused: ''
    }
  };

  function emaUpdate(key, x, alpha) {
    if (alpha == null) alpha = 0.22;
    var prev = rt.resEma[key];
    if (!Number.isFinite(prev)) { rt.resEma[key] = x; return x; }
    var v = prev + alpha * (x - prev);
    rt.resEma[key] = v;
    return v;
  }

  function updateCapHysteresis(snapshot) {
    var a = snapshot && snapshot.res ? snapshot.res['colony:androids'] : null;
    var c = snapshot && snapshot.res ? snapshot.res['colony:colonists'] : null;
    var on = clamp(toNum(state.popCapHystOn, 0.99999), 0.9, 0.9999999);
    var off = clamp(toNum(state.popCapHystOff, 0.9995), 0.9, on);

    if (a && a.cap > 0) {
      var fillA = a.value / a.cap;
      if (!rt.capState.android && fillA >= on) rt.capState.android = true;
      else if (rt.capState.android && fillA <= off) rt.capState.android = false;
    }
    if (c && c.cap > 0) {
      var fillC = c.value / c.cap;
      if (!rt.capState.colonists && fillC >= on) rt.capState.colonists = true;
      else if (rt.capState.colonists && fillC <= off) rt.capState.colonists = false;
    }
  }

  function netIncludingOverflow(st) {
    var net = toNum(st ? st.net : 0, 0);
    var cap = toNum(st ? st.cap : 0, 0);
    var val = toNum(st ? st.value : 0, 0);
    if (cap > 0 && val >= cap * 0.999) net += toNum(st ? st.overflow : 0, 0);
    return net;
  }

  function wantNetDeltaGeneric(cons0, val0) {
    var cons = Math.max(0, cons0);
    var val = Math.max(0, val0);

    if (cons <= 0) return 0;

    var bufferS = clamp(state.bufferSeconds, 5, 600);
    var softS = clamp(state.softHorizonSeconds, 60, 3600);
    var refillS = clamp(state.refillSeconds, 10, 600);
    var bandMul = clamp(state.strengthenBand, 1.0, 10.0);

    var targetVal = cons * bufferS;

    if (val < targetVal) {
      return (targetVal - val) / refillS;
    }

    if (state.preferNetZero) return 0;

    var allowed = -(val - targetVal) / softS;

    var bandVal = targetVal * bandMul;
    if (val < bandVal) {
      var denom = Math.max(1e-9, (bandVal - targetVal));
      var k = (bandVal - val) / denom;
      k = clamp(k, 0, 1);
      allowed = allowed * (1 - k);
    }
    return allowed;
  }

  function wantNetDeltaPop(st) {
    // Cap-fill demand: generate positive net until near cap even if consumption==0.
    var cap = Math.max(0, toNum(st ? st.cap : 0, 0));
    var val = Math.max(0, toNum(st ? st.value : 0, 0));
    var cons = Math.max(0, toNum(st ? st.cons : 0, 0));

    var want = 0;
    if (cap > 0) {
      var band = clamp(toNum(state.popCapBandFrac, 0.002), 1e-5, 0.25);
      var targetVal = cap * (1 - band * 0.05); // aim extremely close to cap, but avoid numerical chatter
      if (val < targetVal) {
        var fillS = clamp(toNum(state.capFillSeconds, 45), 5, 600);
        want = Math.max(want, (targetVal - val) / fillS);
      }
    }

    // If consumption exists, require a small positive margin to stay pinned at cap.
    if (cons > 0) {
      var m = clamp(toNum(state.popConsMarginFrac, 0.002), 0, 0.05);
      want = Math.max(want, cons * m);
    }

    // Do not allow negative "wanted" for pop resources; goal is pinned-to-cap, not buffer decay.
    return Math.max(0, want);
  }

  function wantNetDelta(resKey, st) {
    if (isPopRes(resKey)) return wantNetDeltaPop(st);
    var cons = toNum(st ? st.cons : 0, 0);
    var val = toNum(st ? st.value : 0, 0);
    return wantNetDeltaGeneric(cons, val);
  }

  function resourceSecondsOfCons(st) {
    var cons = toNum(st ? st.cons : 0, 0);
    var val = toNum(st ? st.value : 0, 0);
    if (!(cons > 0)) return Infinity;
    return Math.max(0, val) / cons;
  }

  function timeToReachSeconds(st, targetSeconds) {
    var cons = Math.max(0, toNum(st ? st.cons : 0, 0));
    if (!(cons > 0)) return 0;
    var val = Math.max(0, toNum(st ? st.value : 0, 0));
    var targetVal = cons * Math.max(0, targetSeconds);
    var need = targetVal - val;
    if (!(need > 0)) return 0;
    var net = netIncludingOverflow(st);
    if (!(net > 0)) return Infinity;
    return need / net;
  }

  function capDeficitSeverity(st) {
    // Works even if consumption==0. Intended mainly for colonists/androids.
    var cap = Math.max(0, toNum(st ? st.cap : 0, 0));
    if (!(cap > 0)) return 0;
    var val = Math.max(0, toNum(st ? st.value : 0, 0));
    var def = Math.max(0, cap - val);
    var band = clamp(toNum(state.popCapBandFrac, 0.002), 1e-5, 0.25);
    var denom = cap * band;
    if (!(denom > 0)) return 0;
    return clamp(def / denom, 0, 1);
  }

  function emergencySeverity(resKey, st, bufferS) {
    if (!st) return 0;

    // Base buffer logic (consumption-driven)
    var cons = Math.max(0, toNum(st.cons, 0));
    var val = Math.max(0, toNum(st.value, 0));
    var sev = 0;

    if (cons > 0) {
      var secs = val / cons;

      var secsTerm = 0;
      if (secs < bufferS) {
        secsTerm = clamp((bufferS - secs) / bufferS, 0, 1);

        var grace = clamp(state.refillSeconds, 5, 600);
        var tToBuf = timeToReachSeconds(st, bufferS);
        var fastCut = grace * 0.35;

        if (tToBuf <= fastCut) {
          secsTerm = 0;
        } else if (tToBuf < grace && secsTerm > 0) {
          var k = clamp((tToBuf - fastCut) / Math.max(1e-9, (grace - fastCut)), 0, 1);
          secsTerm = secsTerm * k;
        }
      }

      var net = netIncludingOverflow(st);
      var netTerm = 0;
      var netDead = cons * 0.003;
      if (secs < bufferS * 2 && net < -netDead) {
        var mag = ((-net) - netDead) / (cons + 1e-9);
        netTerm = clamp(mag, 0, 1) * clamp((bufferS * 2 - secs) / (bufferS * 2), 0, 1);
      }

      sev = Math.max(secsTerm, netTerm);
    }

    // Pop resources get cap-deficit severity as an additional driver.
    if (isPopRes(resKey)) sev = Math.max(sev, capDeficitSeverity(st));

    return (sev < 0.01) ? 0 : sev;
  }

  function emergLevelUpdate(resKey, target, dtSec) {
    var prev = rt.emergEma[resKey];
    if (!Number.isFinite(prev)) prev = 0;

    // faster rise than decay to reduce oscillation
    var up = 6.0;
    var down = 1.4;
    var rate = (target > prev) ? up : down;

    var k = 1 - Math.exp(-rate * clamp(dtSec, 0.01, 5));
    var v = prev + (target - prev) * k;

    if (v < 0.005) v = 0;
    rt.emergEma[resKey] = v;
    return v;
  }

  // One-hop coupling to reduce component/electronics seesaw.
  var EMERG_DEPS = {
    'colony:electronics': ['colony:components'],
    'colony:superconductors': ['colony:electronics', 'colony:components'],
    'colony:superalloys': ['colony:superconductors', 'colony:electronics', 'colony:components']
  };

  function adjustSafeguards(snapshot) {
    var now = Date.now();
    var dtSec = (now - rt.lastSafeguardAt) / 1000;
    if (dtSec < 0.7) return;
    rt.lastSafeguardAt = now;

    updateCapHysteresis(snapshot);

    var alloc = getAllocBuildings(snapshot);
    for (var i = 0; i < alloc.length; i++) {
      var b = alloc[i];
      var produces = b && b.produces ? b.produces : [];
      if (!produces || !produces.length) continue;

      var keys = [];
      for (var p = 0; p < produces.length; p++) {
        var rk = produces[p];
        if (!rk || isExcludedForSafeguards(rk)) continue;
        keys.push(rk);
      }
      if (!keys.length) continue;

      var worstErr = 0;
      var safeToDecay = true;

      for (var j = 0; j < keys.length; j++) {
        var key = keys[j];
        var st = snapshot && snapshot.res ? snapshot.res[key] : null;
        if (!st) continue;

        var net = toNum(st.net, 0);
        var cap = toNum(st.cap, 0);
        var val = toNum(st.value, 0);
        if (cap > 0 && val >= cap * 0.999) net += toNum(st.overflow, 0);

        var ema = emaUpdate(key, net, 0.22);
        var want = wantNetDelta(key, st);
        var err = want - ema;
        if (err > worstErr) worstErr = err;

        // Decay gating: only decay when "clearly safe" (err well below 0 + not near buffer band).
        var cons = Math.max(1e-9, toNum(st.cons, 0));
        var deadband = cons * 0.001;

        if (err > 0) safeToDecay = false;
        if (err > -deadband) safeToDecay = false;

        var secs = resourceSecondsOfCons(st);
        var bufferS = clamp(state.bufferSeconds, 5, 600);
        var bandS = bufferS * clamp(state.strengthenBand, 1, 10);
        if (secs < bandS) {
          var graceS = clamp(state.refillSeconds, 10, 600);
          var tBand = timeToReachSeconds(st, bandS);
          if (tBand > graceS) safeToDecay = false;
        }

        // Pop resources: treat any deficit as not safe to decay.
        if (isPopRes(key) && capDeficitSeverity(st) > 0) safeToDecay = false;
      }

      var cur = toNum(boostPctByKey[b.key], 0);
      if (worstErr > 0) {
        // Scale error to avoid pop resources (cons==0) causing gigantic rel => stepUp slams to 95%.
        var scale = 1;
        var popDriven = false;

        for (var j2 = 0; j2 < keys.length; j2++) {
          var k2 = keys[j2];
          if (isPopRes(k2)) popDriven = true;

          var st2 = snapshot && snapshot.res ? snapshot.res[k2] : null;
          if (!st2) continue;

          // Normal resources: scale by consumption.
          var cns = Math.max(1e-9, toNum(st2.cons, 0));
          if (cns > scale) scale = cns;

          // Pop resources: scale by cap-fill demand / observed scale so rel is sane.
          if (isPopRes(k2)) {
            var w = Math.abs(wantNetDelta(k2, st2));            // cap-fill desired net
            var e = Math.abs(toNum(rt.resEma[k2], 0));          // observed net EMA magnitude
            if (w > scale) scale = w;
            if (e > scale) scale = e;
          }
        }

        var rel = worstErr / Math.max(1e-9, scale);
        var mag = Math.log10(rel + 1);

        // Pop-driven boosts should rise slower to avoid “pin to cap” demanding 95% instantly.
        var stepUp = popDriven
          ? clamp(0.008 * (1 + 3 * mag), 0.001, 0.05)
          : clamp(0.010 * (1 + 6 * mag), 0.002, 0.18);

        boostPctByKey[b.key] = clamp(cur + stepUp, 0, 95);
      } else if (safeToDecay && cur > 0) {
        var decayPerSec = 0.35;
        var factor = Math.pow(1 - decayPerSec, Math.min(dtSec, 10));
        boostPctByKey[b.key] = clamp(cur * factor, 0, 95);
      }
    }

    saveBoosts();
  }

  // ---------------- Max learning ----------------
  function resetMaxLearner(hard) {
    rt.maxLearn.obs = [];
    rt.maxLearn.mean = 0;
    rt.maxLearn.mad = 0;
    rt.maxLearn.lastScore = NaN;
    rt.maxLearn.trial = null;
    rt.maxLearn.paused = '';
    if (hard) rt.maxLearn.lastStepAt = 0;
  }

  function collectDepsFor(rk) {
    var out = [];
    var seen = {};
    function rec(k, depth) {
      if (depth > 5) return;
      var deps = EMERG_DEPS[k];
      if (!deps || !deps.length) return;
      for (var i = 0; i < deps.length; i++) {
        var d = deps[i];
        if (!d || seen[d]) continue;
        seen[d] = true;
        out.push(d);
        rec(d, depth + 1);
      }
    }
    rec(rk, 0);
    return out;
  }

  function updateMaxScore(snapshot) {
    var rk = state.maxResKey;
    if (!rk) return;

    var st = snapshot && snapshot.res ? snapshot.res[rk] : null;
    if (!st) return;

    var obs = netIncludingOverflow(st);

    var arr = rt.maxLearn.obs;
    arr.push(obs);
    if (arr.length > 80) arr.shift();

    var n = arr.length;
    if (n < 6) return;

    var W = Math.min(20, n);
    var start = n - W;

    var sum = 0;
    for (var i = start; i < n; i++) sum += arr[i];
    var mean = sum / W;

    var madSum = 0;
    for (var j = start + 1; j < n; j++) madSum += Math.abs(arr[j] - arr[j - 1]);
    var mad = madSum / Math.max(1, (W - 1));

    var penalty = clamp(toNum(state.learnSmooth, 60) / 50, 0, 2);

    rt.maxLearn.mean = mean;
    rt.maxLearn.mad = mad;
    rt.maxLearn.lastScore = mean - penalty * mad;
  }

  function startMaxTrial(snapshot) {
    var rk = state.maxResKey;
    if (!rk) return false;
    if (!state.running) { rt.maxLearn.paused = 'paused (allocator stopped)'; return false; }

    var alloc = getAllocBuildings(snapshot);
    if (!alloc || !alloc.length) return false;

    var enabled = [];
    var sumW = 0;
    for (var i = 0; i < alloc.length; i++) {
      var b = alloc[i];
      var rs = rowState[b.key] || {};
      if (rs.enabled === false) continue;
      var w = Math.max(0, toNum(rs.weight, 0));
      enabled.push({ key: b.key, w: w, produces: (b.produces || []) });
      sumW += w;
    }
    if (!enabled.length) { rt.maxLearn.paused = 'paused (no enabled buildings)'; return false; }

    var deps = collectDepsFor(rk);
    var chain = {}; chain[rk] = true;
    for (var d = 0; d < deps.length; d++) chain[deps[d]] = true;

    var candidates = [];
    var direct = [];
    var candSet = {};
    for (var e = 0; e < enabled.length; e++) {
      var pr = enabled[e].produces;
      var hit = false;
      var hitDirect = false;
      for (var p = 0; p < pr.length; p++) {
        var rr = pr[p];
        if (!rr) continue;
        if (rr === rk) hitDirect = true;
        if (chain[rr]) hit = true;
      }
      if (hit) { candidates.push(enabled[e].key); candSet[enabled[e].key] = true; }
      if (hitDirect) direct.push(enabled[e].key);
    }
    if (!candidates.length) { rt.maxLearn.paused = 'paused (no candidate producers)'; return false; }

    // If all weights are zero, seed candidate producers evenly to bootstrap learning.
    if (!(sumW > 0)) {
      var seed = 100 / candidates.length;
      for (var s = 0; s < enabled.length; s++) rowState[enabled[s].key].weight = 0;
      for (var c = 0; c < candidates.length; c++) {
        if (!rowState[candidates[c]]) rowState[candidates[c]] = {};
        rowState[candidates[c]].weight = Math.max(0, seed);
      }
      saveRows();
      return true;
    }

    function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

    // Choose a decrement key from any positive-weight building, preferring outside the chain.
    var posKeys = [];
    for (var k0 = 0; k0 < enabled.length; k0++) {
      var kk = enabled[k0].key;
      var ww = Math.max(0, toNum((rowState[kk] || {}).weight, 0));
      if (ww > 0) posKeys.push(kk);
    }
    if (!posKeys.length) { rt.maxLearn.paused = 'paused (no positive weights)'; return false; }

    var posOutside = [];
    for (var po = 0; po < posKeys.length; po++) if (!candSet[posKeys[po]]) posOutside.push(posKeys[po]);
    var decKey = pick(posOutside.length ? posOutside : posKeys);

    // Increment target: prefer direct producers, else any chain producer, else any enabled.
    var incPool = [];
    for (var di = 0; di < direct.length; di++) if (direct[di] !== decKey) incPool.push(direct[di]);
    if (!incPool.length) for (var ci = 0; ci < candidates.length; ci++) if (candidates[ci] !== decKey) incPool.push(candidates[ci]);
    if (!incPool.length) for (var ei = 0; ei < enabled.length; ei++) if (enabled[ei].key !== decKey) incPool.push(enabled[ei].key);
    if (!incPool.length) { rt.maxLearn.paused = 'paused (no valid trade)'; return false; }

    var incKey = pick(incPool);
    if (incKey === decKey) return false;

    var baseScore = toNum(rt.maxLearn.lastScore, NaN);
    if (!Number.isFinite(baseScore)) { rt.maxLearn.paused = 'warming up (score not ready)'; return false; }

    var wInc = Math.max(0, toNum((rowState[incKey] || {}).weight, 0));
    var wDec = Math.max(0, toNum((rowState[decKey] || {}).weight, 0));

    var agg = clamp(toNum(state.learnAgg, 35) / 100, 0, 1);
    var delta = clamp(sumW * (0.01 + 0.05 * agg), 0.2, 20);
    delta = Math.min(delta, wDec);
    if (!(delta > 1e-6)) { rt.maxLearn.paused = 'paused (delta=0)'; return false; }

    if (!rowState[incKey]) rowState[incKey] = {};
    if (!rowState[decKey]) rowState[decKey] = {};

    rowState[incKey].weight = wInc + delta;
    rowState[decKey].weight = wDec - delta;
    saveRows();

    rt.maxLearn.trial = {
      incKey: incKey,
      decKey: decKey,
      delta: delta,
      baseScore: baseScore,
      oldInc: wInc,
      oldDec: wDec,
      startedAt: Date.now(),
      settleUntil: Date.now() + clamp(toNum(state.learnSettleSec, 8), 3, 60) * 1000
    };
    return true;
  }

  function finishMaxTrial() {
    var tr = rt.maxLearn.trial;
    if (!tr) return;

    var curScore = toNum(rt.maxLearn.lastScore, NaN);
    if (!Number.isFinite(curScore) || !Number.isFinite(tr.baseScore)) {
      rowState[tr.incKey].weight = tr.oldInc;
      rowState[tr.decKey].weight = tr.oldDec;
      saveRows();
      rt.maxLearn.trial = null;
      return;
    }

    var eps = Math.max(Math.abs(tr.baseScore) * 0.0005, 1e-9);
    if (curScore >= tr.baseScore + eps) {
      rt.maxLearn.trial = null;
      return;
    }

    rowState[tr.incKey].weight = tr.oldInc;
    rowState[tr.decKey].weight = tr.oldDec;
    saveRows();
    rt.maxLearn.trial = null;
  }

  function maxLearnTick(snapshot) {
    if (rt.maxLearn.resKey !== state.maxResKey) {
      rt.maxLearn.resKey = state.maxResKey || null;
      resetMaxLearner(false);
    }
    if (!state.maxResKey) return;

    updateMaxScore(snapshot);

    if (rt.maxLearn.trial) {
      if (Date.now() >= rt.maxLearn.trial.settleUntil) finishMaxTrial();
      return;
    }

    if ((rt.maxLearn.obs || []).length < 16) { rt.maxLearn.paused = 'warming up (observations)'; return; }

    var now = Date.now();
    var intervalMs = clamp(toNum(state.learnIntervalSec, 8), 3, 60) * 1000;
    if (now - (rt.maxLearn.lastStepAt || 0) < intervalMs) return;

    var started = startMaxTrial(snapshot);
    if (started) rt.maxLearn.lastStepAt = now;
  }

  // ---------------- compute plan ----------------
  function computePlan(snapshot) {
    var workerCap = toNum(snapshot.workerCap, 0);
    var pop = toNum(snapshot.pop, 0);
    var popCap = toNum(snapshot.popCap, 0);

    var fixed = getFixedBuildings(snapshot);
    var alloc = getAllocBuildings(snapshot);

    var fixedWorkers = 0;
    for (var i = 0; i < fixed.length; i++) {
      var fb = fixed[i];
      var cnt = fb.autoBuildEnabled ? (Number.isFinite(fb.targetCount) ? fb.targetCount : 0) : toNum(fb.active, 0);
      fixedWorkers += cnt * toNum(fb.effNeed, 0);
    }
    var remainder = Math.max(0, workerCap - fixedWorkers);

    var cloneKey = findBuildingKeyByName(snapshot, /clon/i);
    var androidKey = findBuildingKeyByName(snapshot, /android/i);
    var shipKey = findBuildingKeyByName(snapshot, /shipyard|ship\b/i);
    var biodomeKey = findBuildingKeyByName(snapshot, /biodome/i);

    var stColonists = snapshot && snapshot.res ? snapshot.res['colony:colonists'] : null;
    var stAndroids = snapshot && snapshot.res ? snapshot.res['colony:androids'] : null;

    // "Hard-capped" only when hysteresis says capped AND there is no consumption pressure.
    var colonistsCapped = !!rt.capState.colonists && stColonists && stColonists.cap > 0 && (stColonists.cons <= 0);
    var androidsCapped = !!rt.capState.android && stAndroids && stAndroids.cap > 0 && (stAndroids.cons <= 0);

    // Deficit factors (0..1): strong under cap, fades near cap.
    function deficitFactorFor(st) {
      if (!st) return 0;
      if (!(toNum(st.cap, 0) > 0)) return 0;
      var sev = capDeficitSeverity(st); // already banded 0..1
      // Keep a tiny floor if consumption exists (avoids "fully off" in steady-state where tiny drops matter).
      if (toNum(st.cons, 0) > 0) sev = Math.max(sev, 0.10);
      return clamp(sev, 0, 1);
    }
    var defColonists = deficitFactorFor(stColonists);
    var defAndroids = deficitFactorFor(stAndroids);

    // Floors are expressed in workers (not buildings) before conversion; later we ceil by effNeed.
    var floorWorkersByKey = {};
    function addFloorWorkers(k, w) {
      if (!k || !(w > 0)) return;
      floorWorkersByKey[k] = (floorWorkersByKey[k] || 0) + w;
    }

    // Deficit-scaled "Min" floors
    if (state.keepClonesMin && cloneKey && !colonistsCapped) {
      addFloorWorkers(cloneKey, remainder * (clamp(state.minPctClones, 0, 10) / 100) * defColonists);
    }
    if (state.keepAndroidsMin && androidKey && !androidsCapped) {
      addFloorWorkers(androidKey, remainder * (clamp(state.minPctAndroids, 0, 10) / 100) * defAndroids);
    }
    if (state.keepShipsMin && shipKey) {
      // ships are not cap-stabilized here; min ships is always a fixed minimum when enabled
      addFloorWorkers(shipKey, remainder * (clamp(state.minPctShips, 0, 10) / 100));
    }
    if (state.keepBiodomesMin && biodomeKey && !colonistsCapped) {
      addFloorWorkers(biodomeKey, remainder * (clamp(state.minPctBiodomes, 0, 10) / 100) * defColonists);
    }

    // Emergency floor distribution based on resource severity, plus dependency coupling.
    var producersByRes = {};
    for (var pb = 0; pb < alloc.length; pb++) {
      var pbld = alloc[pb];
      var pr = pbld && pbld.produces ? pbld.produces : [];
      for (var pi = 0; pi < pr.length; pi++) {
        var rk = pr[pi];
        if (!rk || isExcludedForSafeguards(rk)) continue;
        if (!producersByRes[rk]) producersByRes[rk] = [];
        producersByRes[rk].push(pbld.key);
      }
    }

    var resMap = snapshot && snapshot.res ? snapshot.res : {};
    var bufferS2 = clamp(state.bufferSeconds, 5, 600);

    var nowE = Date.now();
    var dtE = (nowE - (rt.lastEmergencyAt || nowE)) / 1000;
    if (!Number.isFinite(dtE) || dtE <= 0) dtE = 0.5;
    dtE = clamp(dtE, 0.1, 5);
    rt.lastEmergencyAt = nowE;

    var targetSev = {};
    for (var rk2 in resMap) {
      if (!resMap.hasOwnProperty(rk2)) continue;
      if (isExcludedForSafeguards(rk2)) continue;
      targetSev[rk2] = emergencySeverity(rk2, resMap[rk2], bufferS2);
    }

    // Dependency propagation: if output is severely starved and an input is tight, lift the input severity.
    function depPropagationFactor(depSt, bufferS) {
      if (!depSt) return 0;

      var cap = toNum(depSt.cap, 0);
      var val = Math.max(0, toNum(depSt.value, 0));

      if (cap > 0 && val >= cap * 0.995) return 0;

      var cons = Math.max(0, toNum(depSt.cons, 0));
      if (!(cons > 0)) return 0;

      var secs = val / cons;
      if (secs < bufferS * 1.5) return 1;
      if (secs < bufferS * 4) return clamp((bufferS * 4 - secs) / (bufferS * 2.5), 0, 1);

      var net = netIncludingOverflow(depSt);
      var dead = cons * 0.01;
      if (net < -dead && secs < bufferS * 10) return 0.2;

      return 0;
    }

    for (var outKey in targetSev) {
      if (!targetSev.hasOwnProperty(outKey)) continue;
      var sevOut = targetSev[outKey];
      if (!(sevOut > 0)) continue;

      var deps = EMERG_DEPS[outKey];
      if (!deps || !deps.length) continue;

      for (var di = 0; di < deps.length; di++) {
        var dep = deps[di];
        if (isExcludedForSafeguards(dep)) continue;

        var depSt = resMap[dep];
        var f = depPropagationFactor(depSt, bufferS2);
        if (f > 0) targetSev[dep] = Math.max(toNum(targetSev[dep], 0), sevOut * 0.75 * f);
      }
    }

    var emergList = [];
    var maxSev = 0;
    for (var rk3 in targetSev) {
      if (!targetSev.hasOwnProperty(rk3)) continue;
      var prodKeys = producersByRes[rk3];
      if (!prodKeys || !prodKeys.length) continue;

      var sevSm = emergLevelUpdate(rk3, targetSev[rk3], dtE);
      if (!(sevSm > 0)) continue;

      emergList.push({ rk: rk3, sev: sevSm, producers: prodKeys });
      if (sevSm > maxSev) maxSev = sevSm;
    }

    if (remainder > 0 && emergList.length) {
      emergList.sort(function (a, b) { return b.sev - a.sev; });
      if (emergList.length > 8) emergList.length = 8;

      var sumTop = 0;
      for (var si = 0; si < emergList.length; si++) sumTop += emergList[si].sev;

      if (sumTop > 0) {
        var budgetPct = clamp(6 + 49 * maxSev, 0, 55);
        var budgetWorkers = remainder * (budgetPct / 100);

        for (var ei = 0; ei < emergList.length; ei++) {
          var e = emergList[ei];
          var wBudget = budgetWorkers * (e.sev / sumTop);
          var per = wBudget / e.producers.length;
          for (var pk = 0; pk < e.producers.length; pk++) addFloorWorkers(e.producers[pk], per);
        }
      }
    }

    // Persistent boosts (controller output from adjustSafeguards)
    for (var a = 0; a < alloc.length; a++) {
      var bb = alloc[a];
      var bp = toNum(boostPctByKey[bb.key], 0);
      if (bp > 0) addFloorWorkers(bb.key, remainder * (bp / 100));
    }

    // --- FLOOR CAP: prevent stacked floors (min + emergency + boost) exceeding remainder ---
    // Without this, floorWorkersUsed can exceed `remainder`, remainForWeights becomes 0,
    // and overshoot trimming can't reduce floors (causing negative free workers + runaway counts).
    var totalFloorReq = 0;
    for (var fk0 in floorWorkersByKey) {
      if (!floorWorkersByKey.hasOwnProperty(fk0)) continue;
      totalFloorReq += toNum(floorWorkersByKey[fk0], 0);
    }
    if (totalFloorReq > remainder && totalFloorReq > 0) {
      var s = remainder / totalFloorReq;
      for (var fk1 in floorWorkersByKey) {
        if (!floorWorkersByKey.hasOwnProperty(fk1)) continue;
        floorWorkersByKey[fk1] = toNum(floorWorkersByKey[fk1], 0) * s;
      }
    }

    var effByKey = {};
    for (var b2 = 0; b2 < snapshot.buildings.length; b2++) effByKey[snapshot.buildings[b2].key] = toNum(snapshot.buildings[b2].effNeed, 0);

    // Convert floor workers -> floor building counts
    var floorCountByKey = {};
    var floorWorkersUsed = 0;
    for (var k in floorWorkersByKey) {
      if (!floorWorkersByKey.hasOwnProperty(k)) continue;
      var eff = effByKey[k] || 0;
      if (!(eff > 0)) continue;
      var w = floorWorkersByKey[k];
      var ccount = Math.ceil(w / eff);
      floorCountByKey[k] = (floorCountByKey[k] || 0) + ccount;
      floorWorkersUsed += ccount * eff;
    }

    var remainForWeights = Math.max(0, remainder - floorWorkersUsed);

    // Weighted pool (skips pop buildings only when hard-capped)
    var enabled = [];
    var sumW = 0;
    for (var a2 = 0; a2 < alloc.length; a2++) {
      var bld = alloc[a2];
      var rs = rowState[bld.key] || {};
      if (rs.enabled === false) continue;

      if (bld.key === cloneKey && colonistsCapped) continue;
      if (bld.key === androidKey && androidsCapped) continue;

      var wgt = Math.max(0, toNum(rs.weight, 0));
      if (!(wgt > 0)) continue;
      enabled.push({ b: bld, w: wgt });
      sumW += wgt;
    }

    var targetCountByKey = {};
    // Seed from floors
    for (var fk in floorCountByKey) {
      if (!floorCountByKey.hasOwnProperty(fk)) continue;
      targetCountByKey[fk] = (targetCountByKey[fk] || 0) + floorCountByKey[fk];
    }

    // Add weighted distribution
    if (sumW > 0 && remainForWeights > 0) {
      for (var e2 = 0; e2 < enabled.length; e2++) {
        var eb = enabled[e2].b;
        var effE = Math.max(1e-9, toNum(eb.effNeed, 0));
        var shareWorkers = remainForWeights * (enabled[e2].w / sumW);
        var addCnt = Math.floor((shareWorkers / effE) + 1e-9);
        targetCountByKey[eb.key] = (targetCountByKey[eb.key] || 0) + addCnt;
      }
    }

    function assignedTotalWorkers() {
      var total = fixedWorkers;
      for (var i3 = 0; i3 < alloc.length; i3++) {
        var b3 = alloc[i3];
        total += toNum(targetCountByKey[b3.key], 0) * toNum(b3.effNeed, 0);
      }
      return total;
    }

    // Trim overshoot (never below floor counts)
    var assigned = assignedTotalWorkers();
    if (assigned > workerCap + 1e-6) {
      var overshoot = assigned - workerCap;
      var candidates2 = [];
      for (var cidx = 0; cidx < alloc.length; cidx++) {
        var cbld = alloc[cidx];
        var rs2 = rowState[cbld.key] || {};
        var w2 = Math.max(0, toNum(rs2.weight, 0));
        var cnt2 = toNum(targetCountByKey[cbld.key], 0);
        var floorCnt = toNum(floorCountByKey[cbld.key], 0);
        if (cnt2 > floorCnt) candidates2.push({ b: cbld, w: w2, cnt: cnt2, floorCnt: floorCnt });
      }
      candidates2.sort(function (a, b) { return a.w - b.w; });

      for (var ci2 = 0; ci2 < candidates2.length && overshoot > 0; ci2++) {
        var cnd = candidates2[ci2];
        var effC = Math.max(1e-9, toNum(cnd.b.effNeed, 0));
        var canRemove = Math.min(cnd.cnt - cnd.floorCnt, Math.ceil(overshoot / effC));
        if (canRemove > 0) {
          targetCountByKey[cnd.b.key] -= canRemove;
          overshoot -= canRemove * effC;
        }
      }
    }

    // Fill slack to top weight building (best-effort)
    assigned = assignedTotalWorkers();
    if (assigned < workerCap - 1e-6) {
      var slack = workerCap - assigned;
      if (enabled.length) {
        enabled.sort(function (a, b) { return b.w - a.w; });
        var best = enabled[0].b;
        var effB = Math.max(1e-9, toNum(best.effNeed, 0));
        var add = Math.floor(slack / effB);
        if (add > 0) targetCountByKey[best.key] = (targetCountByKey[best.key] || 0) + add;
      }
    }

    // Produce apply pct + worker bars
    var percentByKey = {};
    var workersByKey = {};
    var workerShareByKey = {};

    for (var i4 = 0; i4 < alloc.length; i4++) {
      var b4 = alloc[i4];
      var cnt4 = toNum(targetCountByKey[b4.key], 0);
      var eff4 = toNum(b4.effNeed, 0);
      var workers = cnt4 * eff4;
      workersByKey[b4.key] = workers;
      workerShareByKey[b4.key] = (workerCap > 0) ? (workers / workerCap) : 0;
      percentByKey[b4.key] = (workerCap > 0) ? (cnt4 * 100 / workerCap) : 0;
    }

    // Breakdowns for status card
    var allocWorkersTotal = 0;
    for (var i5 = 0; i5 < alloc.length; i5++) allocWorkersTotal += toNum(workersByKey[alloc[i5].key], 0);
    var weightedWorkers = Math.max(0, allocWorkersTotal - floorWorkersUsed);

    return {
      workerCap: workerCap,
      workerFree: toNum(snapshot.workerFree, 0),
      pop: pop, popCap: popCap,
      fixedWorkers: fixedWorkers,
      remainder: remainder,
      floorWorkersUsed: floorWorkersUsed,
      weightedWorkersUsed: weightedWorkers,
      remainForWeights: remainForWeights,
      alloc: alloc,
      fixed: fixed,
      cloneKey: cloneKey, androidKey: androidKey, shipKey: shipKey, biodomeKey: biodomeKey,
      colonistsCapped: colonistsCapped, androidsCapped: androidsCapped,
      floorCountByKey: floorCountByKey,
      targetCountByKey: targetCountByKey,
      percentByKey: percentByKey,
      workersByKey: workersByKey,
      workerShareByKey: workerShareByKey
    };
  }

  // ---------------- apply + render ----------------
  function applyPlan(plan) {
    if (!state.running) return;

    var now = Date.now();
    if (now - rt.lastApplyAt < 320) return;
    rt.lastApplyAt = now;

    var updates = {};
    for (var i = 0; i < plan.alloc.length; i++) {
      var b = plan.alloc[i];
      var pct = toNum(plan.percentByKey[b.key], 0);
      var prev = toNum(rt.lastAppliedPct[b.key], NaN);
      if (!Number.isFinite(prev) || Math.abs(prev - pct) > 1e-12) {
        updates[b.key] = { autoBuildPercent: pct };
        rt.lastAppliedPct[b.key] = pct;
      }
    }
    var keys = Object.keys(updates);
    if (!keys.length) return;

    var api = getApi();
    var res = api && typeof api.apply === 'function' ? api.apply(updates) : null;
    if (res && res.ok === false) {
      state.running = false;
      ui.runBtn.textContent = 'Start';
      saveSettings();
    }

    // Optional nudge for engines that only recompute on helper call.
    try {
      var refreshAll = getPageProp('refreshAllAutoBuildTargets');
      if (typeof refreshAll === 'function') refreshAll();
    } catch (e) {}
  }

  function renderWaiting(reason) {
    var msg = reason || 'Waiting for game globals (resources/buildings)…';
    ui.statusCard.innerHTML = ''
      + '<div class="ttwa-row" style="justify-content:space-between">'
      + '  <div class="ttwa-kv"><div class="k">Status</div><div class="v"><span class="ttwa-badge">Not ready</span></div></div>'
      + '  <div class="ttwa-mini ttwa-muted">Open the Colony/Buildings tabs once if the page delays global init.</div>'
      + '</div>'
      + '<div class="ttwa-mini ttwa-muted" style="margin-top:8px">' + escapeHtml(msg) + '</div>';
  }

  function renderStatus(snapshot, plan) {
    var stC = snapshot && snapshot.res ? snapshot.res['colony:colonists'] : null;
    var stA = snapshot && snapshot.res ? snapshot.res['colony:androids'] : null;

    function fillStr(st) {
      var cap = toNum(st ? st.cap : 0, 0);
      var val = toNum(st ? st.value : 0, 0);
      if (!(cap > 0)) return 'n/a';
      return (val / cap * 100).toFixed(4) + '%';
    }
    function netStr(st) { return fmtNum(netIncludingOverflow(st)); }

    var maxLabel = (state.maxResKey ? resKeyLabel(state.maxResKey) : null);
    var score = Number.isFinite(rt.maxLearn.lastScore) ? fmtNum(rt.maxLearn.lastScore) : '…';
    var mean = Number.isFinite(rt.maxLearn.mean) ? fmtNum(rt.maxLearn.mean) : '…';

    ui.statusCard.innerHTML =
      '<div class="ttwa-grid">'
      + '  <div class="ttwa-kv">'
      + '    <div class="k">Workers</div>'
      + '    <div class="v">'
      + '      <span class="ttwa-badge">cap ' + fmtNum(plan.workerCap) + '</span>'
      + '      <span class="ttwa-badge">free ' + fmtNum(plan.workerFree) + '</span>'
      + '    </div>'
      + '    <div class="ttwa-mini ttwa-muted" style="margin-top:4px">'
      + '      fixed ' + fmtNum(plan.fixedWorkers) + ' · floors ' + fmtNum(plan.floorWorkersUsed) + ' · weights ' + fmtNum(plan.weightedWorkersUsed)
      + '    </div>'
      + '  </div>'
      + '  <div class="ttwa-kv">'
      + '    <div class="k">Pop caps</div>'
      + '    <div class="v">'
      + '      <span class="ttwa-badge">colonists ' + fmtNum(toNum(stC ? stC.value : plan.pop, 0)) + '/' + fmtNum(toNum(stC ? stC.cap : plan.popCap, 0)) + ' (' + fillStr(stC) + ')</span>'
      + '      <span class="ttwa-badge">androids ' + fmtNum(toNum(stA ? stA.value : 0, 0)) + '/' + fmtNum(toNum(stA ? stA.cap : 0, 0)) + ' (' + fillStr(stA) + ')</span>'
      + '    </div>'
      + '    <div class="ttwa-mini ttwa-muted" style="margin-top:4px">'
      + '      net C ' + netStr(stC) + '/s · net A ' + netStr(stA) + '/s'
      + '    </div>'
      + '  </div>'
      + '</div>'
      + '<div class="ttwa-row" style="margin-top:8px;justify-content:space-between">'
      + '  <div class="ttwa-mini ttwa-muted">Safeguards target ~' + Math.round(state.bufferSeconds) + 's buffers; pops are pinned to cap (cap-fill + margin if consuming).</div>'
      + '  <div class="ttwa-mini ttwa-muted">'
      + (maxLabel ? ('Max <b>' + escapeHtml(maxLabel) + '</b> · score ' + score + ' · mean ' + mean + (rt.maxLearn.paused ? (' · ' + escapeHtml(rt.maxLearn.paused)) : '')) : 'Max: off')
      + '  </div>'
      + '</div>';
  }

  function renderTable(snapshot, plan) {
    var rows = ui.allocCard.querySelectorAll('tr[data-key]');
    if (!rows || !rows.length) return;

    var allocMap = {};
    for (var i = 0; i < plan.alloc.length; i++) allocMap[plan.alloc[i].key] = plan.alloc[i];

    for (var r = 0; r < rows.length; r++) {
      var tr = rows[r];
      var key = tr.getAttribute('data-key');
      var b = allocMap[key];
      if (!b) continue;

      var cb = tr.querySelector('.ttwa-use');
      var cbMax = tr.querySelector('.ttwa-max');
      var inp = tr.querySelector('.ttwa-weight');
      var infoBtn = tr.querySelector('.ttwa-info');
      var bar = tr.querySelector('.ttwa-bar');
      var barFill = tr.querySelector('.ttwa-barfill');
      var barText = tr.querySelector('.ttwa-bartext');

      var rs = rowState[key] || {};
      var en = (rs.enabled !== false);
      if (cb.checked !== en) cb.checked = en;

      if (document.activeElement !== inp) {
        var wv = toNum(rs.weight, 0);
        if (inp.value !== String(wv)) inp.value = String(wv);
      }

      var maxrk = tr.getAttribute('data-maxrk') || '';
      var wantMax = (state.maxBuildingKey === key);
      if (cbMax.checked !== wantMax) cbMax.checked = wantMax;
      cbMax.disabled = !maxrk || isExcludedForMax(maxrk);

      var floorCnt = toNum(plan.floorCountByKey[key], 0);
      var tgtCnt = toNum(plan.targetCountByKey[key], 0);
      var eff = toNum(b.effNeed, 0);
      var workers = toNum(plan.workersByKey[key], 0);
      var share = toNum(plan.workerShareByKey[key], 0);
      var boost = toNum(boostPctByKey[key], 0);

      // Workers bar = worker share, not autoBuildPercent.
      var pctFill = clamp(share * 100, 0, 100);
      barFill.style.width = pctFill.toFixed(2) + '%';
      barText.textContent = fmtNum(workers);

      // Info tooltip
      var produces = (b.produces || []).filter(function (x) { return x && !isExcludedForSafeguards(x); });
      var prodStr = produces.length ? produces.map(function (x) { return '<code>' + escapeHtml(x) + '</code>'; }).join(' ') : '<span class="ttwa-muted">none</span>';

      var infoHtml =
        '<div class="tt">' + escapeHtml(b.displayName) + '</div>' +
        '<div class="ln"><div class="lk">Key</div><div class="lv"><code>' + escapeHtml(b.key) + '</code></div></div>' +
        '<div class="ln"><div class="lk">Enabled</div><div class="lv">' + (en ? 'yes' : 'no') + '</div></div>' +
        '<div class="ln"><div class="lk">Weight</div><div class="lv">' + fmtPct(toNum(rs.weight, 0)) + '</div></div>' +
        '<div class="ln"><div class="lk">Workers/building</div><div class="lv">' + fmtNum(eff) + '</div></div>' +
        '<div class="ln"><div class="lk">Floor buildings</div><div class="lv">' + fmtNum(floorCnt) + (boost > 0 ? (' · boost ' + fmtPct(boost) + '%') : '') + '</div></div>' +
        '<div class="ln"><div class="lk">Target buildings</div><div class="lv">' + fmtNum(tgtCnt) + '</div></div>' +
        '<div class="ln"><div class="lk">Workers</div><div class="lv">' + fmtNum(workers) + ' (' + pctFill.toFixed(3) + '% cap)</div></div>' +
        '<div class="ln"><div class="lk">Produces</div><div class="lv">' + prodStr + '</div></div>';

      setTip(infoBtn, infoHtml);
      setTip(bar, '<div class="tt">Workers allocation</div>' +
        '<div class="ln"><div class="lk">Workers</div><div class="lv">' + fmtNum(workers) + '</div></div>' +
        '<div class="ln"><div class="lk">Share</div><div class="lv">' + (pctFill.toFixed(3)) + '% of cap</div></div>');
    }
  }

  // ---------------- main loop ----------------
  function tick() {
    injectBridge();

    var api = getApi();
    if (!api || typeof api.ready !== 'function') {
      renderWaiting('Bridge API not available yet.');
      return;
    }
    if (!api.ready()) {
      renderWaiting('Game state not initialized yet.');
      return;
    }

    var snapshot = api.snapshot();
    ensureRows(snapshot);

    adjustSafeguards(snapshot);
    maxLearnTick(snapshot);

    var plan = computePlan(snapshot);
    applyPlan(plan);

    renderStatus(snapshot, plan);
    renderTable(snapshot, plan);

    ui.body.style.maxHeight = 'calc(100vh - 24px - ' + (ui.header.getBoundingClientRect().height || 52) + 'px)';
    ui.body.style.overflow = 'auto';
  }

  // boot
  buildUI();
  injectBridge();
  setInterval(tick, 500);
  tick();

})();
