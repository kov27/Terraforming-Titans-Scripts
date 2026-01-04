// ==UserScript==
// @name         Terraforming Titans Data Inspector (Overlay + Variable Map)
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.1.0
// @description  Read-only overlay that lists (and maps paths to) resources, production/consumption, energy, buildings, projects/research (best-effort), plus a globals scanner to help you find variables fast.
// @author       kov27
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  /**
   * ===========================
   * WHAT THIS SCRIPT IS FOR
   * ===========================
   * This is a READ-ONLY “inspector” overlay.
   * It tries to expose all useful in-game data in one place, PLUS the *path* to reach it in code.
   *
   * Examples of paths you’ll see:
   *   window.resources.colony.energy.value
   *   window.structures["oreMine"].count
   *
   * If the game updates and variable names change, use the "Globals Scan" tab
   * to discover new global objects and their shapes.
   */

  const VER = '0.1.0';

  // ============================================================
  // 1) VM/Firefox sandbox bridge helpers
  // ============================================================
  // In userscripts (Violentmonkey/Tampermonkey), you often run in a sandbox.
  // The real game variables live on the page context.
  // We use:
  //   - unsafeWindow + wrappedJSObject (Firefox) for direct access where possible
  //   - an injected bridge script (best compatibility)
  const __UW__ = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const __PAGE__ = (__UW__ && __UW__.wrappedJSObject) ? __UW__.wrappedJSObject : __UW__;

  function getPageProp(name) {
    try { if (__PAGE__ && typeof __PAGE__[name] !== 'undefined') return __PAGE__[name]; } catch (e) {}
    try { if (__UW__ && typeof __UW__[name] !== 'undefined') return __UW__[name]; } catch (e2) {}
    return undefined;
  }

  // ============================================================
  // 2) Bridge API (injected into page) + direct fallback
  // ============================================================
  function injectBridge() {
    if (getPageProp('__TT_INSPECT__')) return;

    // NOTE: This code executes in the page context (so it can see window.resources etc).
    const code = `
(function(){
  if (window.__TT_INSPECT__) return;

  function safeNumber(x){ return (typeof x==='number' && isFinite(x)) ? x : 0; }

  // Avoid crashing when traversing unknown shapes.
  function tryGet(obj, key){ try { return obj ? obj[key] : undefined; } catch(e){ return undefined; } }

  // Heuristic: detect DOM nodes so we don’t try to serialize them.
  function isDomNode(x){
    try { return x && typeof x === 'object' && (x.nodeType === 1 || x.nodeType === 9) && typeof x.nodeName === 'string'; }
    catch(e){ return false; }
  }

  // Depth-limited, circular-safe clone to JSON-friendly data.
  // This is intentionally conservative: it won’t copy huge graphs deeply unless you enable "Deep".
  function cloneLite(x, depth, seen){
    if (depth <= 0) return summarize(x);
    if (x == null) return x;
    const t = typeof x;
    if (t === 'string' || t === 'boolean') return x;
    if (t === 'number') return isFinite(x) ? x : String(x);
    if (t === 'function') return '[Function ' + (x.name || 'anon') + ']';
    if (t !== 'object') return String(x);
    if (isDomNode(x)) return '[DOM ' + x.nodeName + ']';

    if (!seen) seen = new WeakSet();
    if (seen.has(x)) return '[Circular]';
    seen.add(x);

    if (Array.isArray(x)) {
      const out = [];
      const lim = Math.min(x.length, 80); // prevent huge UI blobs
      for (let i=0;i<lim;i++) out.push(cloneLite(x[i], depth-1, seen));
      if (x.length > lim) out.push('[… ' + (x.length - lim) + ' more]');
      return out;
    }

    const out = {};
    const keys = Object.keys(x);
    const lim = Math.min(keys.length, 120);
    for (let i=0;i<lim;i++){
      const k = keys[i];
      const v = tryGet(x, k);
      // Skip extremely noisy things (you can still find them in Deep mode)
      if (k === 'parent' || k === 'ownerDocument') continue;
      out[k] = cloneLite(v, depth-1, seen);
    }
    if (keys.length > lim) out['[moreKeys]'] = '[… ' + (keys.length - lim) + ' more keys]';
    return out;
  }

  function summarize(x){
    if (x == null) return x;
    const t = typeof x;
    if (t === 'string') return x.length > 160 ? x.slice(0,159) + '…' : x;
    if (t === 'number') return isFinite(x) ? x : String(x);
    if (t === 'boolean') return x;
    if (t === 'function') return '[Function ' + (x.name || 'anon') + ']';
    if (t !== 'object') return String(x);
    if (isDomNode(x)) return '[DOM ' + x.nodeName + ']';
    if (Array.isArray(x)) return '[Array len=' + x.length + ']';
    return '[Object keys=' + Object.keys(x).length + ']';
  }

  // Resources: expected shape seen in your allocator script:
  //   resources[category][resource] = { value, cap, productionRate, consumptionRate, overflowRate, unlocked, ... }
  function readResources(){
    const res = (typeof resources !== 'undefined') ? resources : null;
    if (!res || typeof res !== 'object') return null;

    const out = { categories: {}, paths: {} };

    for (const cat of Object.keys(res)) {
      const bucket = res[cat];
      if (!bucket || typeof bucket !== 'object') continue;

      out.categories[cat] = {};
      for (const rk of Object.keys(bucket)) {
        const r = bucket[rk];
        if (!r || typeof r !== 'object') continue;

        out.categories[cat][rk] = {
          value: safeNumber(r.value),
          cap: safeNumber(r.cap),
          productionRate: safeNumber(r.productionRate),
          consumptionRate: safeNumber(r.consumptionRate),
          overflowRate: safeNumber(r.overflowRate),
          unlocked: !!r.unlocked
        };

        // This is the important bit for learning: where the variable lives.
        out.paths[cat + ':' + rk] = 'window.resources.' + cat + '.' + rk;
      }
    }

    return out;
  }

  // Buildings/structures:
  // In some versions: window.structures
  // In others: window.buildings + window.colonies
  function getBuildingCollections(){
    const structs = (typeof structures !== 'undefined') ? structures : null;
    const blds    = (typeof buildings  !== 'undefined') ? buildings  : null;
    const cols    = (typeof colonies   !== 'undefined') ? colonies   : null;

    if (structs && typeof structs === 'object') {
      return { merged: structs, sources: { structures: true, buildings: false, colonies: false }, pathHint: 'window.structures' };
    }

    // Merge buildings + colonies (best-effort)
    const merged = {};
    let any = false;
    if (blds && typeof blds === 'object') { try { Object.assign(merged, blds); any = true; } catch(e){} }
    if (cols && typeof cols === 'object') { try { Object.assign(merged, cols); any = true; } catch(e){} }
    if (!any) return { merged: null, sources: { structures: false, buildings: !!blds, colonies: !!cols }, pathHint: 'window.buildings / window.colonies' };

    return { merged, sources: { structures: false, buildings: !!blds, colonies: !!cols }, pathHint: 'window.buildings / window.colonies' };
  }

  function nonZeroEntry(v){
    if (v == null) return false;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'object') {
      if (typeof v.amount === 'number') return v.amount !== 0;
      for (const k in v) if (typeof v[k] === 'number' && v[k] !== 0) return true;
    }
    return false;
  }

  function listProducedKeys(b){
    const out = [];
    const prod = b && b.production ? b.production : {};
    for (const cat in prod) {
      const obj = prod[cat];
      if (!obj || typeof obj !== 'object') continue;
      for (const res in obj) out.push(cat + ':' + res);
    }
    return out;
  }

  function listConsumedKeys(b){
    const out = [];
    const cons = b && b.consumption ? b.consumption : {};
    for (const cat in cons) {
      const obj = cons[cat];
      if (!obj || typeof obj !== 'object') continue;
      for (const res in obj) if (nonZeroEntry(obj[res])) out.push(cat + ':' + res);
    }
    return out;
  }

  function effectiveWorkerNeed(b){
    try {
      let base = 0;
      if (b && typeof b.getTotalWorkerNeed === 'function') base = safeNumber(b.getTotalWorkerNeed());
      else base = safeNumber(b ? b.requiresWorker : 0);

      let mult = 1;
      if (b && typeof b.getEffectiveWorkerMultiplier === 'function') mult = safeNumber(b.getEffectiveWorkerMultiplier());
      if (!mult) mult = 1;

      return base * mult;
    } catch(e) {
      return 0;
    }
  }

  function readBuildings(){
    const col = getBuildingCollections();
    const collection = col.merged;
    if (!collection || typeof collection !== 'object') return { list: [], sources: col.sources, pathHint: col.pathHint };

    const list = [];
    for (const key of Object.keys(collection)) {
      const b = collection[key];
      if (!b || typeof b !== 'object') continue;

      // Collect “obvious” fields you’ll want while coding:
      const displayName = b.displayName || b.name || key;

      list.push({
        key,
        displayName,
        category: b.category || '',
        unlocked: !!b.unlocked,
        isHidden: !!b.isHidden,
        count: safeNumber(b.count),
        active: safeNumber(b.active),
        requiresWorker: safeNumber(b.requiresWorker),
        effWorkerNeed: effectiveWorkerNeed(b),

        autoBuildEnabled: !!b.autoBuildEnabled,
        autoActiveEnabled: !!b.autoActiveEnabled,
        autoBuildBasis: String(b.autoBuildBasis || ''),
        autoBuildPercent: safeNumber(b.autoBuildPercent),

        produces: listProducedKeys(b),
        consumes: listConsumedKeys(b),

        // Key learning feature: how to reach this object.
        // Note: if this is from merged buildings+colonies, the exact container might differ.
        pathGuess: (col.sources.structures ? 'window.structures["' + key + '"]'
                 : 'window.buildings["' + key + '"] (or window.colonies["' + key + '"])'),

        // Show you what else exists on the object without opening devtools:
        keys: Object.keys(b).slice(0, 80)
      });
    }

    list.sort((a,b) => (String(a.category).localeCompare(String(b.category)) || String(a.displayName).localeCompare(String(b.displayName))));
    return { list, sources: col.sources, pathHint: col.pathHint };
  }

  // “Known globals” we try first (these names may differ across game versions).
  const KNOWN_GLOBAL_NAMES = [
    'resources','structures','buildings','colonies',
    'projects','project','projectManager','currentProject',
    'research','researchManager','tech','techTree','technologies','upgrades','milestones',
    'game','state','save','settings'
  ];

  function summarizeGlobal(name, val){
    if (val == null) return null;
    const t = typeof val;
    if (t === 'function') return { name, type: 'function', summary: '[Function ' + (val.name||'anon') + ']' };
    if (t !== 'object') return { name, type: t, summary: String(val) };
    if (Array.isArray(val)) return { name, type: 'array', summary: 'len=' + val.length };
    return { name, type: 'object', summary: 'keys=' + Object.keys(val).length };
  }

  // One-time scan of window keys for “interesting” objects (opt-in from UI).
  function scanGlobals(){
    const out = [];
    try {
      const keys = Object.keys(window);
      const MAX = 6000; // safety
      const lim = Math.min(keys.length, MAX);

      for (let i=0;i<lim;i++){
        const k = keys[i];
        // skip obvious browser noise
        if (!k) continue;
        if (k.startsWith('webkit') || k.startsWith('moz') || k.startsWith('on')) continue;
        if (k === 'localStorage' || k === 'sessionStorage') continue;

        let v;
        try { v = window[k]; } catch(e){ continue; }
        if (v == null) continue;

        // heuristics: “game-like” objects often have these properties
        if (typeof v === 'object') {
          const ks = Object.keys(v);
          const hasResourcesShape = (k.toLowerCase().includes('res') && (v.colony || v.special));
          const hasBuildShape = (k.toLowerCase().includes('struct') || k.toLowerCase().includes('build') || k.toLowerCase().includes('colon'));
          const hasProjShape = (k.toLowerCase().includes('proj') || k.toLowerCase().includes('research') || k.toLowerCase().includes('tech'));

          if (hasResourcesShape || hasBuildShape || hasProjShape || ks.includes('productionRate') || ks.includes('consumptionRate')) {
            out.push({ name: k, type: Array.isArray(v) ? 'array' : 'object', keys: ks.slice(0, 30), summary: summarize(v) });
          }
        } else if (typeof v === 'function') {
          // sometimes managers are functions/constructors
          if (k.toLowerCase().includes('game') || k.toLowerCase().includes('manager')) {
            out.push({ name: k, type: 'function', keys: [], summary: summarize(v) });
          }
        }
      }
    } catch(e) {}

    out.sort((a,b) => String(a.name).localeCompare(String(b.name)));
    return out;
  }

  // Optional helper: search for a text in resource keys/building names and return likely paths.
  function findPaths(query){
    const q = String(query || '').toLowerCase().trim();
    if (!q) return [];

    const hits = [];

    const res = readResources();
    if (res && res.paths) {
      for (const rk in res.paths) {
        if (!rk) continue;
        if (rk.toLowerCase().includes(q)) hits.push({ kind: 'resource', id: rk, path: res.paths[rk] });
      }
    }

    const b = readBuildings();
    if (b && b.list) {
      for (const it of b.list) {
        const name = String(it.displayName || '');
        if (it.key.toLowerCase().includes(q) || name.toLowerCase().includes(q)) {
          hits.push({ kind: 'building', id: it.key, path: it.pathGuess });
        }
      }
    }

    return hits.slice(0, 120);
  }

  window.__TT_INSPECT__ = {
    mode: 'injected',
    ready: function(){
      try {
        // If resources exists, we can show a lot.
        const resOk = (typeof resources !== 'undefined') && resources && resources.colony;
        // If structures/buildings exists, we can show buildings.
        const bOk = (typeof structures !== 'undefined' && structures) || (typeof buildings !== 'undefined' && buildings) || (typeof colonies !== 'undefined' && colonies);
        return !!(resOk || bOk);
      } catch(e) { return false; }
    },

    snapshot: function(opts){
      opts = opts || {};
      const deep = !!opts.deep;

      const res = readResources();
      const b   = readBuildings();

      const knownGlobals = [];
      for (const name of KNOWN_GLOBAL_NAMES){
        let v;
        try { v = window[name]; } catch(e){ v = null; }
        const s = summarizeGlobal(name, v);
        if (s) knownGlobals.push(s);
      }

      const snap = {
        t: Date.now(),
        deep: deep,
        resources: res,
        buildings: b,
        knownGlobals: knownGlobals
      };

      // If "deep" is on, include depth-limited clones of the big objects.
      if (deep) {
        snap.deepDump = {
          resources: (typeof resources !== 'undefined') ? cloneLite(resources, 3) : null,
          structures: (typeof structures !== 'undefined') ? cloneLite(structures, 2) : null,
          buildings: (typeof buildings !== 'undefined') ? cloneLite(buildings, 2) : null,
          colonies: (typeof colonies !== 'undefined') ? cloneLite(colonies, 2) : null,
          projects: (typeof projects !== 'undefined') ? cloneLite(projects, 2) : null,
          research: (typeof research !== 'undefined') ? cloneLite(research, 2) : null,
          techTree: (typeof techTree !== 'undefined') ? cloneLite(techTree, 2) : null
        };
      }

      return snap;
    },

    scanGlobals: function(){
      return scanGlobals();
    },

    findPaths: function(q){
      return findPaths(q);
    }
  };

  // Optional: convenience alias in console
  window.__TTI__ = window.__TT_INSPECT__;
})();`;

    const s = document.createElement('script');
    s.textContent = code;
    document.documentElement.appendChild(s);
    s.parentNode.removeChild(s);
  }

  // Direct fallback (when injection is blocked).
  function getDirectApi() {
    function safeNumber(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }

    function ready() {
      try {
        const r = getPageProp('resources');
        const s = getPageProp('structures') || getPageProp('buildings') || getPageProp('colonies');
        return !!(r || s);
      } catch (e) { return false; }
    }

    // Minimal direct snapshot: if injection fails, at least show “something”.
    function snapshot(opts) {
      opts = opts || {};
      const deep = !!opts.deep;

      const r = getPageProp('resources');
      const structures = getPageProp('structures');
      const buildings = getPageProp('buildings');
      const colonies = getPageProp('colonies');

      // We won’t deep-clone direct objects here (risk of cycles) — keep it minimal.
      return {
        t: Date.now(),
        deep,
        resources: r ? { note: 'Direct mode: resources available (inspect in console via unsafeWindow/wrappedJSObject).' } : null,
        buildings: (structures || buildings || colonies) ? { note: 'Direct mode: building globals available (inspect in console).' } : null,
        knownGlobals: [
          { name: 'resources', type: r ? 'object' : 'missing', summary: r ? ('keys=' + Object.keys(r).length) : 'missing' },
          { name: 'structures', type: structures ? 'object' : 'missing', summary: structures ? ('keys=' + Object.keys(structures).length) : 'missing' },
          { name: 'buildings', type: buildings ? 'object' : 'missing', summary: buildings ? ('keys=' + Object.keys(buildings).length) : 'missing' },
          { name: 'colonies', type: colonies ? 'object' : 'missing', summary: colonies ? ('keys=' + Object.keys(colonies).length) : 'missing' }
        ],
        deepDump: deep ? { note: 'Deep clone is only available in injected mode.' } : undefined
      };
    }

    return { mode: 'direct', ready, snapshot, scanGlobals: () => [], findPaths: () => [] };
  }

  function getApi() {
    const injected = getPageProp('__TT_INSPECT__');
    if (injected) return injected;
    return getDirectApi();
  }

  // ============================================================
  // 3) Small utilities (formatting / DOM helpers / copy)
  // ============================================================
  const SUFFIX = [[1e24,'Y'],[1e21,'Z'],[1e18,'E'],[1e15,'P'],[1e12,'T'],[1e9,'B'],[1e6,'M'],[1e3,'K']];

  function fmtNum(x) {
    if (!Number.isFinite(x)) return String(x);
    const ax = Math.abs(x);
    for (let i=0;i<SUFFIX.length;i++){
      const v = SUFFIX[i][0], s = SUFFIX[i][1];
      if (ax >= v) {
        const d = (ax >= v*100) ? 0 : (ax >= v*10) ? 1 : 2;
        return (x / v).toFixed(d) + s;
      }
    }
    if (ax >= 100) return x.toFixed(0);
    if (ax >= 10) return x.toFixed(1);
    if (ax >= 1) return x.toFixed(2);
    if (ax === 0) return '0';
    return x.toExponential(3);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'})[c]
    );
  }

  function safeStringify(obj, space) {
    const seen = new WeakSet();
    return JSON.stringify(obj, (k, v) => {
      if (typeof v === 'function') return `[Function ${v.name || 'anon'}]`;
      if (v && typeof v === 'object') {
        // DOM nodes can’t be stringified well
        if (v.nodeType === 1 && typeof v.nodeName === 'string') return `[DOM ${v.nodeName}]`;
        if (seen.has(v)) return '[Circular]';
        seen.add(v);
      }
      if (typeof v === 'number' && !isFinite(v)) return String(v);
      return v;
    }, space == null ? 2 : space);
  }

  function el(tag, attrs, children) {
    const e = document.createElement(tag);
    attrs = attrs || {};
    children = children || [];
    for (const k in attrs) {
      const v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of children) e.appendChild(c);
    return e;
  }

  function addStyle(css) {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  function copyToClipboard(text) {
    const s = String(text == null ? '' : text);
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(s);
    // fallback
    const ta = document.createElement('textarea');
    ta.value = s;
    ta.setAttribute('readonly','readonly');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand('copy'); } catch(e) {}
    document.body.removeChild(ta);
    return Promise.resolve();
  }

  // Simple dragging for the overlay
  function enableDrag(root, handle) {
    let dragging = false, sx=0, sy=0, ox=0, oy=0, pid=null;

    function isInteractive(t){
      try { return !!(t && t.closest && t.closest('button,input,select,textarea,a,label')); }
      catch(e){ return false; }
    }

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      if (isInteractive(e.target)) return;

      dragging = true;
      pid = e.pointerId;
      const r = root.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY;
      ox = r.left; oy = r.top;
      root.style.left = ox + 'px';
      root.style.top = oy + 'px';
      root.style.right = 'auto';

      try { handle.setPointerCapture(pid); } catch(err) {}
      e.preventDefault();
    });

    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (pid != null && e.pointerId !== pid) return;
      root.style.left = (ox + (e.clientX - sx)) + 'px';
      root.style.top  = (oy + (e.clientY - sy)) + 'px';
    });

    window.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      if (pid != null && e.pointerId !== pid) return;
      dragging = false; pid = null;
    });
  }

  // ============================================================
  // 4) UI (overlay) + rendering
  // ============================================================
  addStyle(`
#ttdi-root{position:fixed;top:86px;right:16px;z-index:999999;font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;color:#eaeaf0}
#ttdi-root *{box-sizing:border-box}
#ttdi-panel{width:980px;max-width:calc(100vw - 24px);background:linear-gradient(180deg, rgba(34,30,48,.96) 0%, rgba(18,16,24,.96) 80%);
border:1px solid rgba(140,200,255,.36);border-radius:14px;box-shadow:0 22px 70px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.06) inset;overflow:hidden;backdrop-filter:blur(7px);display:flex;flex-direction:column;resize:horizontal}
#ttdi-header{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.10);cursor:move;background:rgba(0,0,0,.14)}
#ttdi-title{font-weight:900;font-size:13px;letter-spacing:.25px}
#ttdi-spacer{flex:1}
.ttdi-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eaeaf0;border-radius:10px;padding:6px 10px;cursor:pointer}
.ttdi-btn:hover{background:rgba(255,255,255,.14)}
.ttdi-btn.primary{background:rgba(140,200,255,.18);border-color:rgba(140,200,255,.42)}
.ttdi-btn.primary:hover{background:rgba(140,200,255,.26)}
.ttdi-pill{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.16);font-size:11px;white-space:nowrap}
#ttdi-body{padding:10px 12px;display:flex;flex-direction:column;gap:10px;overflow:auto;max-height:calc(100vh - 24px - 54px)}
.ttdi-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}
.ttdi-input{padding:6px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.24);color:#eaeaf0;outline:none}
.ttdi-input:focus{border-color:rgba(140,200,255,.55)}
.ttdi-tabs{display:flex;gap:8px;flex-wrap:wrap}
.ttdi-tab{border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.20);color:#eaeaf0;border-radius:10px;padding:6px 10px;cursor:pointer}
.ttdi-tab.on{background:rgba(140,200,255,.22);border-color:rgba(140,200,255,.48)}
.ttdi-card{border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:10px;background:rgba(0,0,0,.18)}
.ttdi-tablewrap{overflow:auto;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.10)}
table.ttdi-table{width:100%;border-collapse:collapse;table-layout:fixed}
.ttdi-table th,.ttdi-table td{padding:7px 7px;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:top}
.ttdi-table th{font-weight:900;background:rgba(0,0,0,.18);position:sticky;top:0;z-index:2}
.ttdi-muted{opacity:.72}
.ttdi-right{text-align:right}
.ttdi-mono{font-family:ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,monospace}
pre.ttdi-pre{margin:0;white-space:pre-wrap;word-break:break-word}
`);

  const ui = {};
  const state = {
    minimized: false,
    autoRefresh: true,
    deep: false,
    tab: 'resources',
    search: ''
  };

  function buildUI() {
    ui.root = el('div', { id: 'ttdi-root' });
    ui.panel = el('div', { id: 'ttdi-panel' });

    ui.btnRefresh = el('button', { class: 'ttdi-btn primary', text: 'Refresh' });
    ui.btnAuto = el('button', { class: 'ttdi-btn', text: 'Auto: ON' });
    ui.btnDeep = el('button', { class: 'ttdi-btn', text: 'Deep: OFF' });
    ui.btnCopy = el('button', { class: 'ttdi-btn', text: 'Copy JSON' });
    ui.btnMin = el('button', { class: 'ttdi-btn', text: '—' });

    ui.header = el('div', { id: 'ttdi-header' }, [
      el('div', { id: 'ttdi-title', text: `TT Data Inspector v${VER}` }),
      el('div', { id: 'ttdi-spacer' }),
      ui.btnRefresh,
      ui.btnAuto,
      ui.btnDeep,
      ui.btnCopy,
      ui.btnMin
    ]);

    ui.body = el('div', { id: 'ttdi-body' });

    // Status row
    ui.status = el('div', { class: 'ttdi-card' });
    ui.body.appendChild(ui.status);

    // Controls row (tabs + search)
    ui.controls = el('div', { class: 'ttdi-card' });
    ui.body.appendChild(ui.controls);

    // Content card (we render different things per tab into this)
    ui.content = el('div', { class: 'ttdi-card' });
    ui.body.appendChild(ui.content);

    ui.panel.appendChild(ui.header);
    ui.panel.appendChild(ui.body);
    ui.root.appendChild(ui.panel);
    document.body.appendChild(ui.root);

    enableDrag(ui.root, ui.header);

    ui.btnMin.addEventListener('click', () => {
      state.minimized = !state.minimized;
      ui.btnMin.textContent = state.minimized ? '▢' : '—';
      ui.body.style.display = state.minimized ? 'none' : 'flex';
    });

    ui.btnAuto.addEventListener('click', () => {
      state.autoRefresh = !state.autoRefresh;
      ui.btnAuto.textContent = state.autoRefresh ? 'Auto: ON' : 'Auto: OFF';
    });

    ui.btnDeep.addEventListener('click', () => {
      state.deep = !state.deep;
      ui.btnDeep.textContent = state.deep ? 'Deep: ON' : 'Deep: OFF';
      tick(true);
    });

    ui.btnRefresh.addEventListener('click', () => tick(true));

    ui.btnCopy.addEventListener('click', () => {
      if (!ui._lastSnapshot) return;
      copyToClipboard(safeStringify(ui._lastSnapshot, 2));
      ui.btnCopy.textContent = 'Copied';
      setTimeout(() => ui.btnCopy.textContent = 'Copy JSON', 800);
    });

    renderControls();
  }

  function renderControls() {
    const tabs = [
      { id: 'resources', label: 'Resources' },
      { id: 'buildings', label: 'Buildings' },
      { id: 'projects', label: 'Projects/Research' },
      { id: 'globals', label: 'Known Globals' },
      { id: 'scan', label: 'Globals Scan' },
      { id: 'raw', label: 'Raw JSON' }
    ];

    ui.controls.innerHTML = `
      <div class="ttdi-row" style="justify-content:space-between;align-items:flex-end">
        <div>
          <div style="font-weight:900">Views</div>
          <div class="ttdi-muted" style="margin-top:4px">
            Tip: use <span class="ttdi-pill ttdi-mono">Paths</span> to copy/paste where the variable lives.
            Use <span class="ttdi-pill">Globals Scan</span> if the game updated and names changed.
          </div>
        </div>
        <div class="ttdi-row">
          <input id="ttdi-search" class="ttdi-input" style="width:280px" placeholder="Search (name/key/resource)..." value="${escapeHtml(state.search)}">
        </div>
      </div>
      <div class="ttdi-tabs" style="margin-top:10px">
        ${tabs.map(t => `<button class="ttdi-tab ${t.id===state.tab?'on':''}" data-tab="${t.id}">${escapeHtml(t.label)}</button>`).join('')}
      </div>
    `;

    const inp = ui.controls.querySelector('#ttdi-search');
    inp.addEventListener('input', () => {
      state.search = String(inp.value || '');
      renderContent(ui._lastSnapshot);
    });

    const btns = ui.controls.querySelectorAll('button[data-tab]');
    for (const b of btns) {
      b.addEventListener('click', () => {
        state.tab = b.getAttribute('data-tab');
        renderControls();
        renderContent(ui._lastSnapshot);
      });
    }
  }

  function matchesSearch(text) {
    const q = String(state.search || '').toLowerCase().trim();
    if (!q) return true;
    return String(text || '').toLowerCase().includes(q);
  }

  function renderStatus(api, snap) {
    const ready = api && typeof api.ready === 'function' ? !!api.ready() : false;
    const mode = api ? (api.mode || 'unknown') : 'none';
    const when = snap ? new Date(snap.t).toLocaleTimeString() : '—';

    // Try to show an “energy” line if we can find it.
    let energyLine = `<span class="ttdi-pill">energy: n/a</span>`;
    try {
      const res = snap && snap.resources && snap.resources.categories;
      if (res) {
        const c = res.colony || {};
        if (c.energy) {
          const e = c.energy;
          energyLine = `<span class="ttdi-pill">energy ${fmtNum(e.value)}/${fmtNum(e.cap)} · net ${(fmtNum((e.productionRate||0)-(e.consumptionRate||0)))}/s</span>`;
        }
      }
    } catch (e) {}

    ui.status.innerHTML = `
      <div class="ttdi-row" style="justify-content:space-between">
        <div class="ttdi-row">
          <span class="ttdi-pill">mode: ${escapeHtml(mode)}</span>
          <span class="ttdi-pill">${ready ? 'ready' : 'not ready'}</span>
          <span class="ttdi-pill">refreshed: ${escapeHtml(when)}</span>
          ${energyLine}
        </div>
        <div class="ttdi-muted">
          Read-only. No game values are modified.
        </div>
      </div>
    `;
  }

  function renderResources(snap) {
    const res = snap && snap.resources;
    if (!res || !res.categories) {
      ui.content.innerHTML = `<div class="ttdi-muted">No resources object detected yet. Open the game UI tabs once (Colony/Structures) and try again.</div>`;
      return;
    }

    // Flatten resources into rows
    const rows = [];
    const cats = res.categories;
    for (const cat of Object.keys(cats)) {
      const bucket = cats[cat];
      for (const rk of Object.keys(bucket)) {
        const r = bucket[rk];
        const id = `${cat}:${rk}`;
        const path = (res.paths && res.paths[id]) ? res.paths[id] : `window.resources.${cat}.${rk}`;
        rows.push({
          cat, rk,
          value: r.value, cap: r.cap,
          prod: r.productionRate, cons: r.consumptionRate,
          net: (r.productionRate - r.consumptionRate),
          overflow: r.overflowRate,
          unlocked: r.unlocked,
          path
        });
      }
    }

    const filtered = rows.filter(x =>
      matchesSearch(`${x.cat} ${x.rk} ${x.path}`)
    );

    // Safety: don’t render infinite rows
    const LIMIT = 350;
    const show = filtered.slice(0, LIMIT);

    ui.content.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px">Resources</div>
      <div class="ttdi-muted" style="margin-bottom:10px">
        Value/cap and rates per second. “Path” shows where to read it in code.
      </div>
      <div class="ttdi-tablewrap">
        <table class="ttdi-table">
          <colgroup>
            <col style="width:120px">
            <col style="width:150px">
            <col style="width:120px">
            <col style="width:120px">
            <col style="width:110px">
            <col style="width:110px">
            <col style="width:110px">
            <col style="width:90px">
            <col>
          </colgroup>
          <thead>
            <tr>
              <th>Category</th>
              <th>Resource</th>
              <th class="ttdi-right">Value</th>
              <th class="ttdi-right">Cap</th>
              <th class="ttdi-right">Prod/s</th>
              <th class="ttdi-right">Cons/s</th>
              <th class="ttdi-right">Net/s</th>
              <th>Unlocked</th>
              <th>Path</th>
            </tr>
          </thead>
          <tbody>
            ${show.map(x => `
              <tr>
                <td>${escapeHtml(x.cat)}</td>
                <td>${escapeHtml(x.rk)}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.value))}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.cap))}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.prod))}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.cons))}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.net))}</td>
                <td>${x.unlocked ? 'yes' : 'no'}</td>
                <td class="ttdi-mono">${escapeHtml(x.path)}</td>
              </tr>
            `).join('')}
            ${filtered.length > LIMIT ? `<tr><td colspan="9" class="ttdi-muted">… ${filtered.length - LIMIT} more (use Search to narrow)</td></tr>` : ''}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderBuildings(snap) {
    const b = snap && snap.buildings;
    const list = b && b.list ? b.list : [];
    if (!list.length) {
      ui.content.innerHTML = `<div class="ttdi-muted">No buildings/structures detected yet. Try opening the Structures tab in-game once.</div>`;
      return;
    }

    const filtered = list.filter(x =>
      matchesSearch(`${x.category} ${x.displayName} ${x.key} ${(x.produces||[]).join(' ')} ${(x.consumes||[]).join(' ')} ${x.pathGuess} ${(x.keys||[]).join(' ')}`)
    );

    const LIMIT = 260;
    const show = filtered.slice(0, LIMIT);

    ui.content.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px">Buildings / Structures</div>
      <div class="ttdi-muted" style="margin-bottom:10px">
        Shows counts/active, worker needs, auto-build fields, what it produces/consumes, and common object keys.
        <span class="ttdi-pill">Path</span> tells you where the structure object lives.
      </div>
      <div class="ttdi-tablewrap">
        <table class="ttdi-table">
          <colgroup>
            <col style="width:140px">
            <col style="width:220px">
            <col style="width:110px">
            <col style="width:110px">
            <col style="width:120px">
            <col style="width:120px">
            <col style="width:110px">
            <col style="width:220px">
            <col style="width:220px">
            <col>
          </colgroup>
          <thead>
            <tr>
              <th>Category</th>
              <th>Name (key)</th>
              <th class="ttdi-right">Count</th>
              <th class="ttdi-right">Active</th>
              <th class="ttdi-right">Workers/each</th>
              <th>Auto basis</th>
              <th class="ttdi-right">Auto %</th>
              <th>Produces</th>
              <th>Consumes</th>
              <th>Path + Keys</th>
            </tr>
          </thead>
          <tbody>
            ${show.map(x => `
              <tr>
                <td>${escapeHtml(x.category || '')}</td>
                <td>
                  <div style="font-weight:900">${escapeHtml(x.displayName || x.key)}</div>
                  <div class="ttdi-muted ttdi-mono">${escapeHtml(x.key)}</div>
                </td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.count))}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.active))}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.effWorkerNeed || x.requiresWorker || 0))}</td>
                <td class="ttdi-mono">${escapeHtml(x.autoBuildBasis || '')}</td>
                <td class="ttdi-right ttdi-mono">${escapeHtml(fmtNum(x.autoBuildPercent || 0))}</td>
                <td class="ttdi-mono">${escapeHtml((x.produces || []).slice(0,8).join(' '))}${(x.produces||[]).length>8?' …':''}</td>
                <td class="ttdi-mono">${escapeHtml((x.consumes || []).slice(0,8).join(' '))}${(x.consumes||[]).length>8?' …':''}</td>
                <td>
                  <div class="ttdi-mono">${escapeHtml(x.pathGuess || '')}</div>
                  <div class="ttdi-muted ttdi-mono" style="margin-top:4px">
                    keys: ${escapeHtml((x.keys || []).slice(0,18).join(', '))}${(x.keys||[]).length>18?' …':''}
                  </div>
                </td>
              </tr>
            `).join('')}
            ${filtered.length > LIMIT ? `<tr><td colspan="10" class="ttdi-muted">… ${filtered.length - LIMIT} more (use Search to narrow)</td></tr>` : ''}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderProjects(snap) {
    // We don’t know the exact schema for “projects” or “research” across versions,
    // so we show best-effort via knownGlobals + Deep mode if enabled.
    const known = (snap && snap.knownGlobals) ? snap.knownGlobals : [];

    // Pick the likely candidates
    const interesting = known.filter(g => {
      const n = String(g.name || '').toLowerCase();
      return n.includes('project') || n.includes('research') || n.includes('tech') || n.includes('upgrade') || n.includes('milestone');
    });

    const deep = snap && snap.deepDump ? snap.deepDump : null;

    ui.content.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px">Projects / Research (best-effort)</div>
      <div class="ttdi-muted" style="margin-bottom:10px">
        Different game versions name these differently. If this looks empty, go to <b>Globals Scan</b> or enable <b>Deep</b>.
      </div>

      <div class="ttdi-tablewrap" style="margin-bottom:10px">
        <table class="ttdi-table">
          <colgroup>
            <col style="width:220px">
            <col style="width:140px">
            <col>
          </colgroup>
          <thead>
            <tr><th>Global name</th><th>Type</th><th>Summary</th></tr>
          </thead>
          <tbody>
            ${(interesting.length ? interesting : known).slice(0, 30).map(g => `
              <tr>
                <td class="ttdi-mono">${escapeHtml('window.' + g.name)}</td>
                <td>${escapeHtml(g.type)}</td>
                <td class="ttdi-mono">${escapeHtml(g.summary)}</td>
              </tr>
            `).join('')}
          </tbody>
        </table>
      </div>

      ${state.deep && deep ? `
        <div class="ttdi-muted" style="margin-bottom:8px">Deep dump (depth-limited):</div>
        <pre class="ttdi-pre ttdi-mono">${escapeHtml(safeStringify({
          projects: deep.projects,
          research: deep.research,
          techTree: deep.techTree
        }, 2))}</pre>
      ` : `
        <div class="ttdi-muted">Enable <b>Deep</b> to include a small depth-limited clone of projects/research globals (can be slower).</div>
      `}
    `;
  }

  function renderKnownGlobals(snap) {
    const known = (snap && snap.knownGlobals) ? snap.knownGlobals : [];
    ui.content.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px">Known Globals</div>
      <div class="ttdi-muted" style="margin-bottom:10px">
        These are common names the script tries first. If the game updated, use <b>Globals Scan</b>.
      </div>
      <div class="ttdi-tablewrap">
        <table class="ttdi-table">
          <colgroup>
            <col style="width:260px">
            <col style="width:140px">
            <col>
          </colgroup>
          <thead><tr><th>Path</th><th>Type</th><th>Summary</th></tr></thead>
          <tbody>
            ${known.filter(g => matchesSearch(`window.${g.name} ${g.type} ${g.summary}`)).map(g => `
              <tr>
                <td class="ttdi-mono">${escapeHtml('window.' + g.name)}</td>
                <td>${escapeHtml(g.type)}</td>
                <td class="ttdi-mono">${escapeHtml(g.summary)}</td>
              </tr>
            `).join('') || `<tr><td colspan="3" class="ttdi-muted">No matches.</td></tr>`}
          </tbody>
        </table>
      </div>
    `;
  }

  function renderScan(api) {
    // Scan is on-demand because it can be a bit heavy.
    ui.content.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px">Globals Scan (discovery)</div>
      <div class="ttdi-muted" style="margin-bottom:10px">
        Click scan to list “interesting” window globals (projects/tech/managers/etc).
        This helps when the game changes variable names.
      </div>
      <div class="ttdi-row" style="margin-bottom:10px">
        <button id="ttdi-scanbtn" class="ttdi-btn primary">Scan now</button>
        <span class="ttdi-muted">Then use Search to filter. Paths are <span class="ttdi-pill ttdi-mono">window.&lt;name&gt;</span></span>
      </div>
      <div id="ttdi-scanout" class="ttdi-muted">Not scanned yet.</div>
    `;

    const btn = ui.content.querySelector('#ttdi-scanbtn');
    const out = ui.content.querySelector('#ttdi-scanout');

    btn.addEventListener('click', () => {
      let rows = [];
      try {
        rows = api && typeof api.scanGlobals === 'function' ? (api.scanGlobals() || []) : [];
      } catch (e) {
        rows = [];
      }

      const filtered = rows.filter(r => matchesSearch(`${r.name} ${r.type} ${(r.keys||[]).join(' ')} ${r.summary}`));
      const LIMIT = 220;
      const show = filtered.slice(0, LIMIT);

      out.className = '';
      out.innerHTML = `
        <div class="ttdi-tablewrap">
          <table class="ttdi-table">
            <colgroup>
              <col style="width:260px">
              <col style="width:120px">
              <col style="width:280px">
              <col>
            </colgroup>
            <thead><tr><th>Path</th><th>Type</th><th>Keys (sample)</th><th>Summary</th></tr></thead>
            <tbody>
              ${show.map(r => `
                <tr>
                  <td class="ttdi-mono">${escapeHtml('window.' + r.name)}</td>
                  <td>${escapeHtml(r.type)}</td>
                  <td class="ttdi-mono ttdi-muted">${escapeHtml((r.keys||[]).join(', '))}</td>
                  <td class="ttdi-mono">${escapeHtml(String(r.summary||''))}</td>
                </tr>
              `).join('')}
              ${filtered.length > LIMIT ? `<tr><td colspan="4" class="ttdi-muted">… ${filtered.length - LIMIT} more (use Search)</td></tr>` : ''}
            </tbody>
          </table>
        </div>
      `;

      if (!rows.length) {
        out.className = 'ttdi-muted';
        out.textContent = 'Scan returned nothing (either not ready or variable names are unusual in this version). Try Deep + Known Globals, or open the in-game UI tabs and try again.';
      }
    });
  }

  function renderRaw(snap, api) {
    // Also show a “findPaths” helper you can use without hunting.
    ui.content.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px">Raw JSON snapshot</div>
      <div class="ttdi-muted" style="margin-bottom:10px">
        This is what the overlay is reading. Use <b>Copy JSON</b> to paste it somewhere.
        Bonus: quick path finder below (uses the game’s live objects).
      </div>

      <div class="ttdi-row" style="margin-bottom:10px">
        <input id="ttdi-findq" class="ttdi-input" style="width:280px" placeholder="Find paths (e.g. energy, ore, ship, research)..." />
        <button id="ttdi-findbtn" class="ttdi-btn">Find</button>
      </div>
      <div id="ttdi-findout" class="ttdi-muted" style="margin-bottom:10px"></div>

      <pre class="ttdi-pre ttdi-mono">${escapeHtml(safeStringify(snap || {}, 2))}</pre>
    `;

    const findQ = ui.content.querySelector('#ttdi-findq');
    const findBtn = ui.content.querySelector('#ttdi-findbtn');
    const findOut = ui.content.querySelector('#ttdi-findout');

    findBtn.addEventListener('click', () => {
      const q = String(findQ.value || '');
      let hits = [];
      try {
        hits = api && typeof api.findPaths === 'function' ? (api.findPaths(q) || []) : [];
      } catch (e) {
        hits = [];
      }

      if (!hits.length) {
        findOut.className = 'ttdi-muted';
        findOut.textContent = 'No hits.';
        return;
      }

      findOut.className = '';
      findOut.innerHTML = `
        <div class="ttdi-tablewrap">
          <table class="ttdi-table">
            <colgroup>
              <col style="width:120px">
              <col style="width:220px">
              <col>
            </colgroup>
            <thead><tr><th>Kind</th><th>ID</th><th>Path</th></tr></thead>
            <tbody>
              ${hits.slice(0, 80).map(h => `
                <tr>
                  <td>${escapeHtml(h.kind)}</td>
                  <td class="ttdi-mono">${escapeHtml(h.id)}</td>
                  <td class="ttdi-mono">${escapeHtml(h.path)}</td>
                </tr>
              `).join('')}
              ${hits.length > 80 ? `<tr><td colspan="3" class="ttdi-muted">… ${hits.length - 80} more</td></tr>` : ''}
            </tbody>
          </table>
        </div>
      `;
    });
  }

  function renderContent(snap) {
    const api = getApi();

    if (!snap) {
      ui.content.innerHTML = `<div class="ttdi-muted">No snapshot yet.</div>`;
      return;
    }

    if (state.tab === 'resources') renderResources(snap);
    else if (state.tab === 'buildings') renderBuildings(snap);
    else if (state.tab === 'projects') renderProjects(snap);
    else if (state.tab === 'globals') renderKnownGlobals(snap);
    else if (state.tab === 'scan') renderScan(api);
    else if (state.tab === 'raw') renderRaw(snap, api);
  }

  // ============================================================
  // 5) Main loop (refresh snapshot, render)
  // ============================================================
  function tick(force) {
    try {
      injectBridge();

      const api = getApi();
      const ready = api && typeof api.ready === 'function' ? !!api.ready() : false;

      // We always snapshot even if not ready; snapshot() will return minimal info.
      const snap = api && typeof api.snapshot === 'function'
        ? api.snapshot({ deep: !!state.deep })
        : { t: Date.now(), deep: !!state.deep, note: 'No API available.' };

      ui._lastSnapshot = snap;

      renderStatus(api, snap);

      // Only re-render content when forced, or when autoRefresh is enabled.
      if (force || state.autoRefresh) renderContent(snap);

      // If not ready, show a gentle hint in the content area.
      if (!ready && (state.tab === 'resources' || state.tab === 'buildings')) {
        // (We don’t overwrite the whole view; we just let the per-tab renderer show empty states.)
      }
    } catch (e) {
      ui.status.innerHTML = `<div class="ttdi-muted">Error: ${escapeHtml(String(e))}</div>`;
    }
  }

  // Boot
  buildUI();
  injectBridge();
  tick(true);

  // Auto refresh tick
  setInterval(() => {
    if (!state.autoRefresh) return;
    tick(false);
  }, 1000);

})();
