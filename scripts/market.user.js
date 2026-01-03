// ==UserScript==
// @name         Terraforming Titans Galactic Market Automator (Worker-Allocator Style Overlay)
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.4.1
// @description  Automates Galactic Market by setting Buy Amount / Sell Amount inputs + (optionally) toggling Market Run. Robust table/row detection (fixes "Market: 0 rows").
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

  /********************************************************************
   * TT Shared Runtime (same pattern as allocator)
   ********************************************************************/
  const TT = (() => {
    const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;
    const LS = (() => { try { return W.localStorage; } catch { return null; } })();
    const scriptName =
      (typeof GM_info !== 'undefined' && GM_info?.script?.name) ? GM_info.script.name : 'TT-Script';

    const shared = W.__TT_SHARED__ || (W.__TT_SHARED__ = {
      masterEnabled: true,
      pauseUntil: 0,
      locks: {},
      lastAction: '',
      lastError: '',
    });

    if (LS && LS.getItem('tt.masterEnabled') != null) {
      shared.masterEnabled = LS.getItem('tt.masterEnabled') === '1';
    }

    function note(msg) {
      const line = `[${new Date().toISOString()}] ${scriptName}: ${msg}`;
      shared.lastAction = line;
      console.debug(line);
    }
    function error(msg, err) {
      const line = `[${new Date().toISOString()}] ${scriptName}: ERROR ${msg}${err ? ` | ${String(err)}` : ''}`;
      shared.lastError = line;
      console.warn(line);
    }
    function isPaused() { return Date.now() < (shared.pauseUntil || 0); }
    function pause(ms, reason = '') {
      const until = Date.now() + Math.max(0, ms | 0);
      shared.pauseUntil = Math.max(shared.pauseUntil || 0, until);
      note(`PAUSE ${ms}ms${reason ? `: ${reason}` : ''}`);
    }
    function shouldRun() { return !!shared.masterEnabled && !isPaused(); }

    function tryLock(name, ttlMs = 2500) {
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
    function runExclusive(lockName, ttlMs, fn) {
      if (!shouldRun()) return false;
      if (!tryLock(lockName, ttlMs)) return false;
      try {
        fn();
        return true;
      } catch (e) {
        error(`runExclusive(${lockName})`, e);
        pause(1500, `exception in ${lockName}`);
        return false;
      } finally {
        unlock(lockName);
      }
    }

    W.__TT = W.__TT || { shared, pause };
    return { shared, scriptName, note, error, pause, shouldRun, runExclusive };
  })();

  /********************************************************************
   * VM/Firefox sandbox bridge helpers
   ********************************************************************/
  const __UW__ = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;
  const __PAGE__ = (__UW__ && __UW__.wrappedJSObject) ? __UW__.wrappedJSObject : __UW__;

  function getPageProp(name) {
    try { if (__PAGE__ && typeof __PAGE__[name] !== 'undefined') return __PAGE__[name]; } catch { }
    try { if (__UW__ && typeof __UW__[name] !== 'undefined') return __UW__[name]; } catch { }
    return undefined;
  }

  /********************************************************************
   * Storage
   ********************************************************************/
  const STORE_KEY = 'ttgm__';
  const hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

  function getVal(key, def) {
    try {
      if (hasGM) return GM_getValue(key, def);
      const raw = localStorage.getItem(STORE_KEY + key);
      return (raw == null) ? def : JSON.parse(raw);
    } catch { return def; }
  }
  function setVal(key, val) {
    try {
      if (hasGM) return GM_setValue(key, val);
      localStorage.setItem(STORE_KEY + key, JSON.stringify(val));
    } catch { }
  }

  /********************************************************************
   * Utils
   ********************************************************************/
  const SUFFIX_FMT = [[1e24, 'Y'], [1e21, 'Z'], [1e18, 'E'], [1e15, 'P'], [1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  function fmtNum(x) {
    if (!Number.isFinite(x)) return '—';
    const ax = Math.abs(x);
    for (let i = 0; i < SUFFIX_FMT.length; i++) {
      const [v, s] = SUFFIX_FMT[i];
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
  function toNum(x, d = 0) {
    const n = Number(x);
    return Number.isFinite(n) ? n : d;
  }
  function parseNumber(text) {
    if (text == null) return NaN;
    let s = String(text).trim().replace(/,/g, '').replace(/\u2212/g, '-');
    const mSci = s.match(/^-?\d+(\.\d+)?e[+\-]?\d+$/i);
    if (mSci) return Number(s);

    const m = s.match(/^(-?\d+(\.\d+)?)(\s*[a-zA-Z]{1,3})?$/);
    if (!m) {
      const t = s.match(/-?\d+(\.\d+)?(e[+\-]?\d+)?/i);
      return t ? parseNumber(t[0]) : NaN;
    }
    const base = Number(m[1]);
    if (!Number.isFinite(base)) return NaN;
    const suf = (m[3] || '').trim().toLowerCase();
    const mult = (() => {
      if (!suf) return 1;
      if (suf === 'k') return 1e3;
      if (suf === 'm') return 1e6;
      if (suf === 'b') return 1e9;
      if (suf === 't') return 1e12;
      if (suf === 'qa') return 1e15;
      if (suf === 'qi') return 1e18;
      return 1;
    })();
    return base * mult;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function visible(el) {
    if (!el) return false;
    const cs = window.getComputedStyle(el);
    if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
    return true;
  }
  function setNativeValue(input, value) {
    if (!input) return;
    const v = String(value);
    const proto = Object.getPrototypeOf(input);
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, v);
    else input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function sortByLeft(inputs) {
    return inputs.slice().sort((a, b) => {
      try { return a.getBoundingClientRect().left - b.getBoundingClientRect().left; }
      catch { return 0; }
    });
  }
  function looksLikeHeaderRowText(t) {
    t = (t || '').toLowerCase();
    return t.includes('resource') && t.includes('sell amount') && t.includes('buy amount');
  }

  /********************************************************************
   * Settings
   ********************************************************************/
  const DEFAULTS = {
    running: false,
    minimized: false,

    tickMs: 650,

    reserveSeconds: 8,
    buyHorizonSec: 10,
    sellHorizonSec: 10,

    minFundingBuffer: 0,
    desiredFunding: 0,
    manageMarketRun: true,

    dryRun: false,
    maxBuyPerTick: 1e12,
    maxSellPerTick: 1e12,

    resources: {}
  };

  const state = (() => {
    const s = getVal('settings', DEFAULTS);
    const out = {};
    for (const k in DEFAULTS) out[k] = DEFAULTS[k];
    for (const k in s) out[k] = s[k];
    out.resources = out.resources || {};
    return out;
  })();
  function saveSettings() { setVal('settings', state); }

  /********************************************************************
   * Bridge: read live resources from game globals
   ********************************************************************/
  function getDirectApi() {
    function safeNumber(x) { return (typeof x === 'number' && isFinite(x)) ? x : 0; }
    function snapshot() {
      const resources = getPageProp('resources');
      if (!resources || typeof resources !== 'object') return null;

      const list = [];
      let funding = null;

      for (const cat in resources) {
        const grp = resources[cat];
        if (!grp || typeof grp !== 'object') continue;
        for (const key in grp) {
          const r = grp[key];
          if (!r || typeof r !== 'object') continue;
          if (typeof r.value === 'undefined') continue;

          const name = (r.displayName || r.name || key);
          const obj = {
            id: `${cat}:${key}`,
            cat, key,
            name: String(name),
            value: safeNumber(r.value),
            cap: safeNumber(r.cap),
            prod: safeNumber(r.productionRate),
            cons: safeNumber(r.consumptionRate),
            net: safeNumber(r.productionRate) - safeNumber(r.consumptionRate),
            overflow: safeNumber(r.overflowRate),
            unlocked: !!r.unlocked
          };
          list.push(obj);

          const nlow = String(name).toLowerCase();
          const klow = String(key).toLowerCase();
          if (!funding && (nlow === 'funding' || klow === 'funding')) funding = obj;
        }
      }
      return { list, funding };
    }

    return {
      ready() {
        try {
          const resources = getPageProp('resources');
          return !!(resources && resources.colony);
        } catch { return false; }
      },
      snapshot
    };
  }

  function injectBridge() {
    if (getPageProp('__TT_MARKET__')) return;

    const code =
      `(function(){
        if (window.__TT_MARKET__) return;
        function safeNumber(x){ return (typeof x==='number' && isFinite(x)) ? x : 0; }
        window.__TT_MARKET__ = {
          ready: function(){
            try { return (typeof resources!=='undefined') && resources && resources.colony; } catch(e){ return false; }
          },
          snapshot: function(){
            try{
              var out = { list: [], funding: null };
              if (typeof resources==='undefined' || !resources) return out;
              for (var cat in resources){
                var grp = resources[cat];
                if (!grp || typeof grp!=='object') continue;
                for (var key in grp){
                  var r = grp[key];
                  if (!r || typeof r!=='object') continue;
                  if (typeof r.value==='undefined') continue;
                  var name = (r.displayName || r.name || key);
                  var obj = {
                    id: String(cat)+':'+String(key),
                    cat: String(cat),
                    key: String(key),
                    name: String(name),
                    value: safeNumber(r.value),
                    cap: safeNumber(r.cap),
                    prod: safeNumber(r.productionRate),
                    cons: safeNumber(r.consumptionRate),
                    net: safeNumber(r.productionRate) - safeNumber(r.consumptionRate),
                    overflow: safeNumber(r.overflowRate),
                    unlocked: !!r.unlocked
                  };
                  out.list.push(obj);
                  var nlow = String(name).toLowerCase();
                  var klow = String(key).toLowerCase();
                  if (!out.funding && (nlow==='funding' || klow==='funding')) out.funding = obj;
                }
              }
              return out;
            } catch(e){
              return { list: [], funding: null };
            }
          }
        };
      })();`;

    const s = document.createElement('script');
    s.textContent = code;
    document.documentElement.appendChild(s);
    s.parentNode.removeChild(s);
  }

  function getApi() {
    const injected = getPageProp('__TT_MARKET__');
    if (injected && typeof injected.ready === 'function') return injected;
    return getDirectApi();
  }

  /********************************************************************
   * Market DOM detection (FIXED)
   ********************************************************************/
  const market = {
    panel: null,
    table: null,
    runCheckbox: null,
    rows: new Map(), // name -> { name, rowEl, sellInput, buyInput, sellPrice, buyPrice }
    detected: false,
    lastSig: ''
  };

  function findMarketTableInDocument() {
    // Prefer tables that actually contain the column headers.
    const tables = Array.from(document.querySelectorAll('table'));
    let best = null;
    let bestScore = 0;

    for (const t of tables) {
      if (!t || !visible(t)) continue;

      const headerText = (t.querySelector('thead')?.textContent || t.textContent || '').toLowerCase();
      let score = 0;
      if (headerText.includes('sell amount')) score += 3;
      if (headerText.includes('buy amount')) score += 3;
      if (headerText.includes('buy price')) score += 2;
      if (headerText.includes('sell price')) score += 2;
      if (headerText.includes('saturation')) score += 1;
      if (headerText.includes('resource')) score += 1;
      if (headerText.includes('total cost')) score += 2;
      if (headerText.includes('galactic market')) score += 2;

      // Also require it to have multiple numeric/text inputs somewhere.
      const inputs = t.querySelectorAll('input');
      if (inputs.length < 6) score -= 2;

      if (score > bestScore) {
        bestScore = score;
        best = t;
      }
    }

    // Require at least "sell amount" + "buy amount" to be confident.
    if (best && bestScore >= 6) return best;
    return null;
  }

  function findMarketPanelFromTable(table) {
    if (!table) return null;
    // Walk upward to a container that mentions "Galactic Market"
    let el = table;
    for (let i = 0; i < 10 && el; i++) {
      el = el.parentElement;
      if (!el) break;
      const txt = (el.textContent || '').toLowerCase();
      if (txt.includes('galactic market')) return el;
    }
    return table.parentElement || null;
  }

  function findRunCheckbox(panel) {
    if (!panel) return null;
    const roots = [panel, panel.parentElement, panel.closest('main'), document.body].filter(Boolean);

    for (const root of roots) {
      const inputs = Array.from(root.querySelectorAll('input[type="checkbox"]'));
      for (const inp of inputs) {
        const wrap = inp.closest('label') || inp.parentElement;
        const txt = (wrap ? wrap.textContent : '') || '';
        const t = txt.toLowerCase().replace(/\s+/g, ' ').trim();
        if (t === 'run') return inp;
      }
    }
    return null;
  }

  function inferPriceFromRow(rowEl, which) {
    const t = (rowEl.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return NaN;
    const toks = t.match(/-?\d+(\.\d+)?\s*(K|M|B|T|Qa|Qi)?/g) || [];
    const nums = toks.map(parseNumber).filter(n => Number.isFinite(n));
    if (nums.length < 2) return NaN;
    const filtered = nums.filter(n => Math.abs(n) <= 1e9);
    const pool = filtered.length ? filtered : nums;
    return (which === 'sell') ? pool[0] : pool[pool.length - 1];
  }

  function extractRowName(rowEl) {
    // Prefer first TD text if table-based
    const tds = rowEl.querySelectorAll('td');
    if (tds && tds.length) {
      const name = (tds[0].textContent || '').trim().replace(/\s+/g, ' ');
      if (name && !looksLikeHeaderRowText(name)) return name;
    }

    // Fallback: first wordy token
    const txt = (rowEl.textContent || '').trim().replace(/\s+/g, ' ');
    if (!txt) return '';
    const words = txt.split(' ');
    // Choose first alphabetic token
    for (const w of words) {
      if (/^[A-Za-z][A-Za-z\-]*$/.test(w) && w.length <= 30) return w;
    }
    return '';
  }

  function scanMarket() {
    market.panel = null;
    market.table = null;
    market.runCheckbox = null;
    market.rows.clear();
    market.detected = false;

    const table = findMarketTableInDocument();
    if (!table) {
      market.lastSig = '';
      return;
    }

    const panel = findMarketPanelFromTable(table);
    market.table = table;
    market.panel = panel || table.parentElement;
    market.detected = true;

    market.runCheckbox = findRunCheckbox(market.panel);

    // Rows: DO NOT use bounding-box "visible row" filters (this was the bug).
    let rowEls = [];
    const tbodyRows = Array.from(table.querySelectorAll('tbody tr'));
    if (tbodyRows.length) rowEls = tbodyRows;
    else rowEls = Array.from(table.querySelectorAll('tr'));

    for (const rowEl of rowEls) {
      const rowText = (rowEl.textContent || '').trim().replace(/\s+/g, ' ');
      if (!rowText) continue;
      if (looksLikeHeaderRowText(rowText)) continue;
      if (rowEl.querySelectorAll('th').length) continue;

      const inputsAll = Array.from(rowEl.querySelectorAll('input')).filter(inp => inp.type !== 'checkbox');
      if (inputsAll.length < 2) continue;

      // Choose 2 inputs by left-to-right position (sell, buy)
      const inputs = sortByLeft(inputsAll);
      const sellInput = inputs[0];
      const buyInput = inputs[inputs.length - 1];

      const name = extractRowName(rowEl);
      if (!name) continue;

      const sellPrice = inferPriceFromRow(rowEl, 'sell');
      const buyPrice = inferPriceFromRow(rowEl, 'buy');

      market.rows.set(name, { name, rowEl, sellInput, buyInput, sellPrice, buyPrice });
    }

    const sig = Array.from(market.rows.keys()).sort().join('|');
    market.lastSig = sig;

    // Ensure config exists for detected rows
    for (const name of market.rows.keys()) {
      if (!state.resources[name]) {
        state.resources[name] = { enabled: true, hardMin: 0, buyFloor: 0, sellCeiling: 0, priority: 3 };
      }
    }
    saveSettings();
  }

  /********************************************************************
   * Live resource index (map market row name -> resource snapshot)
   ********************************************************************/
  function normalizeKey(s) {
    return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  }
  function buildResourceIndex(snapshot) {
    const idx = new Map();
    if (!snapshot || !snapshot.list) return idx;
    for (const r of snapshot.list) {
      const name = String(r.name || '').trim();
      const key = String(r.key || '').trim();
      const add = (k) => {
        const nk = normalizeKey(k);
        if (!nk) return;
        if (!idx.has(nk)) idx.set(nk, r);
      };
      add(name);
      add(key);
      if (name.endsWith('s')) add(name.slice(0, -1));
      if (key.endsWith('s')) add(key.slice(0, -1));
    }
    return idx;
  }
  function getResForMarketName(resIndex, marketName) {
    if (!resIndex) return null;
    const n = normalizeKey(marketName);
    if (resIndex.has(n)) return resIndex.get(n);
    if (n.endsWith('s') && resIndex.has(n.slice(0, -1))) return resIndex.get(n.slice(0, -1));
    if (resIndex.has(n + 's')) return resIndex.get(n + 's');
    return null;
  }

  /********************************************************************
   * Decision logic
   ********************************************************************/
  function cfg(name) { return state.resources[name] || {}; }
  function prio(name) { return clamp(toNum(cfg(name).priority, 3), 1, 9); }
  function hardMin(name) { return Math.max(0, toNum(cfg(name).hardMin, 0)); }
  function buyFloor(name) { return Math.max(hardMin(name), Math.max(0, toNum(cfg(name).buyFloor, 0))); }
  function sellCeil(name) {
    const v = toNum(cfg(name).sellCeiling, 0);
    if (!Number.isFinite(v) || v <= 0) return Infinity;
    return Math.max(buyFloor(name), v);
  }

  function computePlan(snapshot, resIndex) {
    const funding = snapshot?.funding ? snapshot.funding.value : NaN;
    const fundingKnown = Number.isFinite(funding);
    const minBuf = Math.max(0, toNum(state.minFundingBuffer, 0));
    const desired = Math.max(0, toNum(state.desiredFunding, 0));
    const fundingTarget = Math.max(minBuf, desired);
    const fundingShort = fundingKnown ? (funding < fundingTarget) : false;

    const reserveS = clamp(toNum(state.reserveSeconds, 8), 0, 600);
    const buyH = Math.max(1e-6, clamp(toNum(state.buyHorizonSec, 10), 1, 3600));
    const sellH = Math.max(1e-6, clamp(toNum(state.sellHorizonSec, 10), 1, 3600));

    const sells = [];
    const buys = [];

    for (const [name, row] of market.rows.entries()) {
      const rc = cfg(name);
      if (!rc.enabled) continue;

      const rs = getResForMarketName(resIndex, name);
      const value = rs ? toNum(rs.value, 0) : NaN;
      const cons = rs ? Math.max(0, toNum(rs.cons, 0)) : 0;

      const floor = Math.max(buyFloor(name), cons * reserveS);
      const ceilV = sellCeil(name);
      const ceilSafe = Math.max(ceilV, floor);

      const deficit = Number.isFinite(value) ? Math.max(0, floor - value) : 0;
      const excess = (Number.isFinite(value) && ceilSafe !== Infinity) ? Math.max(0, value - ceilSafe) : 0;

      const hm = hardMin(name);
      const crit = Number.isFinite(value) ? ((value < 0) ? 2 : (value < hm ? 1 : 0)) : 0;

      let sellAmt = 0;
      if (excess > 0 && ceilSafe !== Infinity) {
        sellAmt = Math.ceil(excess / sellH);
        sellAmt = Math.min(sellAmt, toNum(state.maxSellPerTick, 1e12));
        sellAmt = Math.max(0, sellAmt);
      }

      let buyAmt = 0;
      if (deficit > 0) {
        buyAmt = Math.ceil(deficit / buyH);
        buyAmt = Math.min(buyAmt, toNum(state.maxBuyPerTick, 1e12));
        buyAmt = Math.max(0, buyAmt);
      }

      if (sellAmt > 0 && ceilSafe !== Infinity) {
        sells.push({ name, sellAmt, pr: prio(name), unit: Number.isFinite(row.sellPrice) ? row.sellPrice : NaN });
      }
      if (buyAmt > 0) {
        buys.push({ name, buyAmt, pr: prio(name), crit, need: deficit, unit: Number.isFinite(row.buyPrice) ? row.buyPrice : NaN });
      }
    }

    sells.sort((a, b) => (b.pr - a.pr) || (b.sellAmt - a.sellAmt));
    buys.sort((a, b) => (b.crit - a.crit) || (b.pr - a.pr) || (b.need - a.need));

    const planned = new Map();
    for (const s of sells) planned.set(s.name, { buy: 0, sell: s.sellAmt });

    let fundsAvail = fundingKnown ? Math.max(0, funding - minBuf) : 0;

    for (const b of buys) {
      const unit = Number.isFinite(b.unit) ? b.unit : NaN;
      let amt = b.buyAmt;

      if (!fundingKnown) {
        amt = (b.crit > 0) ? Math.min(amt, 1) : 0;
      } else {
        if (fundingShort && desired > 0) {
          if (b.crit === 0) amt = 0;
        }

        if (amt > 0 && Number.isFinite(unit) && unit > 0) {
          const affordable = Math.floor(fundsAvail / unit);
          if (affordable <= 0) amt = (b.crit > 0 && fundsAvail > 0) ? 1 : 0;
          else amt = Math.min(amt, affordable);

          fundsAvail -= amt * unit;
        } else if (amt > 0 && (!Number.isFinite(unit) || unit <= 0)) {
          amt = (b.crit > 0 && fundsAvail > 0) ? 1 : 0;
        }
      }

      const prev = planned.get(b.name) || { buy: 0, sell: 0 };
      planned.set(b.name, { buy: amt, sell: prev.sell });
    }

    return { funding, fundingKnown, fundingTarget, fundingShort, planned, _resIndex: resIndex };
  }

  /********************************************************************
   * UI (same "allocator style" overlay)
   ********************************************************************/
  function addStyle(css) {
    const s = document.createElement('style');
    s.textContent = css;
    document.head.appendChild(s);
  }

  addStyle(
    "#ttgm-root{position:fixed;bottom:18px;right:18px;z-index:999999;font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Cantarell,Noto Sans,sans-serif;color:#eaeaf0}" +
    "#ttgm-root *{box-sizing:border-box}" +
    "#ttgm-panel{width:920px;max-width:calc(100vw - 24px);background:linear-gradient(180deg, rgba(38,32,55,.96) 0%, rgba(20,18,28,.96) 80%);border:1px solid rgba(140,200,255,.36);border-radius:14px;box-shadow:0 22px 70px rgba(0,0,0,.62), 0 0 0 1px rgba(255,255,255,.06) inset;overflow:hidden;backdrop-filter:blur(7px);user-select:none;display:flex;flex-direction:column;resize:horizontal}" +
    "#ttgm-header{display:flex;align-items:center;gap:10px;padding:10px 12px;border-bottom:1px solid rgba(255,255,255,.10);cursor:move;background:rgba(0,0,0,.14)}" +
    "#ttgm-title{font-weight:850;font-size:13px;letter-spacing:.25px}" +
    "#ttgm-spacer{flex:1}" +
    ".ttgm-btn{border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.08);color:#eaeaf0;border-radius:10px;padding:6px 10px;cursor:pointer}" +
    ".ttgm-btn:hover{background:rgba(255,255,255,.14)}" +
    ".ttgm-btn:active{transform:translateY(1px)}" +
    ".ttgm-btn.primary{background:rgba(140,200,255,.18);border-color:rgba(140,200,255,.42)}" +
    ".ttgm-btn.primary:hover{background:rgba(140,200,255,.26)}" +
    ".ttgm-btn.danger{background:rgba(255,90,90,.14);border-color:rgba(255,90,90,.35)}" +
    ".ttgm-btn.danger:hover{background:rgba(255,90,90,.22)}" +
    ".ttgm-mini{opacity:.78;font-size:11px}" +
    ".ttgm-muted{opacity:.72}" +
    ".ttgm-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap}" +
    ".ttgm-input{padding:6px 8px;border-radius:10px;border:1px solid rgba(255,255,255,.16);background:rgba(0,0,0,.24);color:#eaeaf0;outline:none}" +
    ".ttgm-input:focus{border-color:rgba(140,200,255,.55)}" +
    ".ttgm-badge{display:inline-block;padding:2px 8px;border-radius:999px;border:1px solid rgba(255,255,255,.14);background:rgba(0,0,0,.16);font-size:11px;white-space:nowrap}" +
    "#ttgm-body{padding:10px 12px;display:flex;flex-direction:column;gap:10px;overflow:auto;max-height:38vh}" +
    ".ttgm-card{border:1px solid rgba(255,255,255,.10);border-radius:14px;padding:10px;background:rgba(0,0,0,.18)}" +
    ".ttgm-tablewrap{overflow:auto;border-radius:12px;border:1px solid rgba(255,255,255,.10);background:rgba(0,0,0,.10)}" +
    "table.ttgm-table{width:100%;border-collapse:collapse;table-layout:fixed}" +
    ".ttgm-table th,.ttgm-table td{padding:7px 7px;border-bottom:1px solid rgba(255,255,255,.08);vertical-align:middle}" +
    ".ttgm-table th{font-weight:850;background:rgba(0,0,0,.18);position:sticky;top:0;z-index:2}" +
    ".ttgm-right{text-align:right}" +
    ".ttgm-center{text-align:center}" +
    ".ttgm-name{font-weight:850;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}" +
    ".ttgm-small{width:84px;text-align:right}" +
    ".ttgm-pri{width:54px;text-align:right}"
  );

  function el(tag, attrs, kids) {
    const e = document.createElement(tag);
    attrs = attrs || {};
    kids = kids || [];
    for (const k in attrs) {
      const v = attrs[k];
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k === 'html') e.innerHTML = v;
      else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v);
    }
    for (const c of kids) e.appendChild(c);
    return e;
  }

  function clampToViewport(root) {
    if (!root) return;
    const vw = window.innerWidth || 0;
    const vh = window.innerHeight || 0;
    if (!vw || !vh) return;
    const r = root.getBoundingClientRect();
    const minX = 60, minY = 40;
    let left = r.left, top = r.top;
    left = Math.min(Math.max(left, -r.width + minX), vw - minX);
    top = Math.min(Math.max(top, -r.height + minY), vh - minY);
    root.style.left = left + 'px';
    root.style.top = top + 'px';
    root.style.right = 'auto';
    root.style.bottom = 'auto';
    setVal('pos', { left: Math.round(left), top: Math.round(top) });
  }

  function loadPos(root) {
    const p = getVal('pos', null);
    if (p && Number.isFinite(p.left) && Number.isFinite(p.top)) {
      root.style.left = p.left + 'px';
      root.style.top = p.top + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
    }
    clampToViewport(root);
  }

  function enableDrag(root, handle) {
    let dragging = false, pid = null, sx = 0, sy = 0, ox = 0, oy = 0;
    function isInteractive(t) {
      try { return !!(t && t.closest && t.closest('button, input, select, textarea, a, label')); }
      catch { return false; }
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
      root.style.bottom = 'auto';
      try { handle.setPointerCapture(pid); } catch { }
      e.preventDefault();
    });
    window.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      if (pid != null && e.pointerId !== pid) return;
      root.style.left = (ox + (e.clientX - sx)) + 'px';
      root.style.top = (oy + (e.clientY - sy)) + 'px';
      root.style.right = 'auto';
      root.style.bottom = 'auto';
      clampToViewport(root);
    });
    window.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      if (pid != null && e.pointerId !== pid) return;
      dragging = false;
      pid = null;
      clampToViewport(root);
    });
    window.addEventListener('resize', () => clampToViewport(root));
  }

  const ui = {
    root: null, panel: null, header: null, body: null,
    runBtn: null, dryBtn: null, minBtn: null, scanBtn: null, clearBtn: null,
    status: null, tableBody: null,
    fields: {}
  };

  function buildUI() {
    if (ui.root) return;

    ui.root = el('div', { id: 'ttgm-root' });
    ui.panel = el('div', { id: 'ttgm-panel' });

    ui.runBtn = el('button', { class: 'ttgm-btn primary', text: state.running ? 'Running' : 'Stopped' });
    ui.dryBtn = el('button', { class: 'ttgm-btn', text: state.dryRun ? 'Dry: ON' : 'Dry: OFF' });
    ui.scanBtn = el('button', { class: 'ttgm-btn', text: 'Scan' });
    ui.clearBtn = el('button', { class: 'ttgm-btn danger', text: 'Clear Orders' });
    ui.minBtn = el('button', { class: 'ttgm-btn', text: state.minimized ? '▢' : '—' });

    ui.header = el('div', { id: 'ttgm-header' }, [
      el('div', { id: 'ttgm-title', text: 'Galactic Market Automator' }),
      el('div', { id: 'ttgm-spacer' }),
      ui.runBtn, ui.dryBtn, ui.scanBtn, ui.clearBtn, ui.minBtn
    ]);

    ui.body = el('div', { id: 'ttgm-body' });

    const settingsCard = el('div', { class: 'ttgm-card' });
    settingsCard.innerHTML = `
      <div class="ttgm-row" style="justify-content:space-between;align-items:flex-end;gap:12px">
        <div>
          <div style="font-weight:900">Controls</div>
          <div class="ttgm-mini ttgm-muted">Writes Market <b>Buy Amount</b> / <b>Sell Amount</b> inputs. Optionally checks market <b>Run</b>.</div>
        </div>
        <div class="ttgm-mini ttgm-muted" id="ttgm-pills"></div>
      </div>

      <div class="ttgm-row" style="margin-top:10px;gap:10px;align-items:center">
        <span class="ttgm-badge">Tick (ms)</span>
        <input class="ttgm-input" id="ttgm-tick" type="number" min="200" max="5000" step="10" style="width:92px">

        <span class="ttgm-badge">Reserve (s)</span>
        <input class="ttgm-input" id="ttgm-reserve" type="number" min="0" max="600" step="1" style="width:72px">

        <span class="ttgm-badge">Buy horizon (s)</span>
        <input class="ttgm-input" id="ttgm-buyh" type="number" min="1" max="3600" step="1" style="width:72px">

        <span class="ttgm-badge">Sell horizon (s)</span>
        <input class="ttgm-input" id="ttgm-sellh" type="number" min="1" max="3600" step="1" style="width:72px">

        <span class="ttgm-badge">Min funding</span>
        <input class="ttgm-input" id="ttgm-minfund" type="text" style="width:110px">

        <span class="ttgm-badge">Desired funding</span>
        <input class="ttgm-input" id="ttgm-desfund" type="text" style="width:110px">

        <label class="ttgm-mini ttgm-muted" style="display:flex;align-items:center;gap:8px;margin-left:auto">
          <input id="ttgm-manageRun" type="checkbox">
          Manage Market Run
        </label>
      </div>
    `;
    ui.body.appendChild(settingsCard);

    ui.status = el('div', { class: 'ttgm-card' });
    ui.status.innerHTML = `<div class="ttgm-mini ttgm-muted">Status: starting…</div>`;
    ui.body.appendChild(ui.status);

    const tableCard = el('div', { class: 'ttgm-card' });
    tableCard.innerHTML = `
      <div style="font-weight:900;margin-bottom:8px">Per-resource policy</div>
      <div class="ttgm-tablewrap">
        <table class="ttgm-table">
          <colgroup>
            <col style="width:46px">
            <col>
            <col style="width:96px">
            <col style="width:96px">
            <col style="width:96px">
            <col style="width:64px">
            <col style="width:260px">
          </colgroup>
          <thead>
            <tr>
              <th class="ttgm-center">Use</th>
              <th>Resource</th>
              <th class="ttgm-right">Hard min</th>
              <th class="ttgm-right">Buy floor</th>
              <th class="ttgm-right">Sell ceil</th>
              <th class="ttgm-right">Prio</th>
              <th>Live (val / net / plan)</th>
            </tr>
          </thead>
          <tbody id="ttgm-tbody">
            <tr><td colspan="7" class="ttgm-muted">Scan market…</td></tr>
          </tbody>
        </table>
      </div>
    `;
    ui.tableBody = tableCard.querySelector('#ttgm-tbody');
    ui.body.appendChild(tableCard);

    ui.panel.appendChild(ui.header);
    ui.panel.appendChild(ui.body);
    ui.root.appendChild(ui.panel);
    document.body.appendChild(ui.root);

    loadPos(ui.root);
    enableDrag(ui.root, ui.header);

    ui.runBtn.addEventListener('click', () => {
      state.running = !state.running;
      ui.runBtn.textContent = state.running ? 'Running' : 'Stopped';
      saveSettings();
    });
    ui.dryBtn.addEventListener('click', () => {
      state.dryRun = !state.dryRun;
      ui.dryBtn.textContent = state.dryRun ? 'Dry: ON' : 'Dry: OFF';
      saveSettings();
    });
    ui.minBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      ui.minBtn.textContent = state.minimized ? '▢' : '—';
      ui.body.style.display = state.minimized ? 'none' : 'flex';
      saveSettings();
      clampToViewport(ui.root);
    });
    ui.scanBtn.addEventListener('click', () => {
      scanMarket();
      rebuildTable();
      renderStatusLine('Manual scan complete.');
    });
    ui.clearBtn.addEventListener('click', () => {
      clearAllMarketOrders();
    });

    ui.fields.tick = settingsCard.querySelector('#ttgm-tick');
    ui.fields.reserve = settingsCard.querySelector('#ttgm-reserve');
    ui.fields.buyh = settingsCard.querySelector('#ttgm-buyh');
    ui.fields.sellh = settingsCard.querySelector('#ttgm-sellh');
    ui.fields.minfund = settingsCard.querySelector('#ttgm-minfund');
    ui.fields.desfund = settingsCard.querySelector('#ttgm-desfund');
    ui.fields.manageRun = settingsCard.querySelector('#ttgm-manageRun');

    function syncSettingsInputs() {
      ui.fields.tick.value = String(clamp(toNum(state.tickMs, 650), 200, 5000));
      ui.fields.reserve.value = String(clamp(toNum(state.reserveSeconds, 8), 0, 600));
      ui.fields.buyh.value = String(clamp(toNum(state.buyHorizonSec, 10), 1, 3600));
      ui.fields.sellh.value = String(clamp(toNum(state.sellHorizonSec, 10), 1, 3600));
      ui.fields.minfund.value = String(toNum(state.minFundingBuffer, 0));
      ui.fields.desfund.value = String(toNum(state.desiredFunding, 0));
      ui.fields.manageRun.checked = !!state.manageMarketRun;
    }
    syncSettingsInputs();

    ui.fields.tick.addEventListener('change', () => { state.tickMs = clamp(parseNumber(ui.fields.tick.value), 200, 5000); saveSettings(); });
    ui.fields.reserve.addEventListener('change', () => { state.reserveSeconds = clamp(parseNumber(ui.fields.reserve.value), 0, 600); saveSettings(); });
    ui.fields.buyh.addEventListener('change', () => { state.buyHorizonSec = clamp(parseNumber(ui.fields.buyh.value), 1, 3600); saveSettings(); });
    ui.fields.sellh.addEventListener('change', () => { state.sellHorizonSec = clamp(parseNumber(ui.fields.sellh.value), 1, 3600); saveSettings(); });
    ui.fields.minfund.addEventListener('change', () => { state.minFundingBuffer = Math.max(0, parseNumber(ui.fields.minfund.value)); saveSettings(); });
    ui.fields.desfund.addEventListener('change', () => { state.desiredFunding = Math.max(0, parseNumber(ui.fields.desfund.value)); saveSettings(); });
    ui.fields.manageRun.addEventListener('change', () => { state.manageMarketRun = !!ui.fields.manageRun.checked; saveSettings(); });

    ui.body.style.display = state.minimized ? 'none' : 'flex';
  }

  function cfg(name) { return state.resources[name] || {}; }

  function rebuildTable() {
    if (!ui.tableBody) return;

    const names = Object.keys(state.resources).sort((a, b) => a.localeCompare(b));
    if (!names.length) {
      ui.tableBody.innerHTML = `<tr><td colspan="7" class="ttgm-muted">No market resources detected yet. Open the Galactic Market panel then click Scan.</td></tr>`;
      return;
    }

    ui.tableBody.innerHTML = '';
    for (const name of names) {
      const rc = cfg(name);
      const tr = document.createElement('tr');
      tr.setAttribute('data-name', name);
      tr.innerHTML = `
        <td class="ttgm-center"><input type="checkbox" data-field="enabled" ${rc.enabled ? 'checked' : ''}></td>
        <td class="ttgm-name" title="${escapeHtml(name)}">${escapeHtml(name)}</td>
        <td class="ttgm-right"><input class="ttgm-input ttgm-small" type="text" data-field="hardMin" value="${rc.hardMin || 0}"></td>
        <td class="ttgm-right"><input class="ttgm-input ttgm-small" type="text" data-field="buyFloor" value="${rc.buyFloor || 0}"></td>
        <td class="ttgm-right"><input class="ttgm-input ttgm-small" type="text" data-field="sellCeiling" value="${rc.sellCeiling || 0}"></td>
        <td class="ttgm-right"><input class="ttgm-input ttgm-pri" type="text" data-field="priority" value="${rc.priority ?? 3}"></td>
        <td class="ttgm-mini ttgm-muted" data-cell="live">—</td>
      `;

      const chk = tr.querySelector('[data-field="enabled"]');
      chk.addEventListener('change', () => { state.resources[name].enabled = !!chk.checked; saveSettings(); });

      const bind = (field, fn) => {
        const inp = tr.querySelector(`[data-field="${field}"]`);
        if (!inp) return;
        inp.addEventListener('change', () => fn(inp));
      };
      bind('hardMin', (inp) => { state.resources[name].hardMin = Math.max(0, parseNumber(inp.value)); inp.value = String(state.resources[name].hardMin); saveSettings(); });
      bind('buyFloor', (inp) => { state.resources[name].buyFloor = Math.max(0, parseNumber(inp.value)); inp.value = String(state.resources[name].buyFloor); saveSettings(); });
      bind('sellCeiling', (inp) => { state.resources[name].sellCeiling = Math.max(0, parseNumber(inp.value)); inp.value = String(state.resources[name].sellCeiling); saveSettings(); });
      bind('priority', (inp) => { state.resources[name].priority = clamp(parseNumber(inp.value), 1, 9); inp.value = String(state.resources[name].priority); saveSettings(); });

      ui.tableBody.appendChild(tr);
    }
  }

  function renderStatusLine(msg) {
    if (!ui.status) return;
    ui.status.innerHTML = `<div class="ttgm-mini ttgm-muted">${escapeHtml(msg)}</div>`;
  }

  function clearAllMarketOrders() {
    if (!market.detected || market.rows.size === 0) { renderStatusLine('Clear: market not detected.'); return; }
    if (state.dryRun) { renderStatusLine('DRY: would clear all market orders.'); return; }
    for (const row of market.rows.values()) {
      if (row.sellInput) setNativeValue(row.sellInput, 0);
      if (row.buyInput) setNativeValue(row.buyInput, 0);
    }
    renderStatusLine('Cleared all Buy/Sell Amount inputs to 0.');
  }

  function applyPlanToMarket(plan) {
    if (!plan) return;

    if (state.manageMarketRun && market.runCheckbox) {
      const wantOn = state.running;
      if (!!market.runCheckbox.checked !== wantOn) {
        if (!state.dryRun) market.runCheckbox.click();
      }
    }

    for (const [name, row] of market.rows.entries()) {
      const rc = cfg(name);
      const cell = ui.tableBody?.querySelector(`tr[data-name="${CSS.escape(name)}"] [data-cell="live"]`) || null;

      const rs = plan._resIndex ? getResForMarketName(plan._resIndex, name) : null;
      const val = rs ? toNum(rs.value, NaN) : NaN;
      const net = rs ? toNum(rs.net, NaN) : NaN;

      const p = plan.planned.get(name) || { buy: 0, sell: 0 };
      const live = `${Number.isFinite(val) ? fmtNum(val) : '—'} / ${Number.isFinite(net) ? fmtNum(net) + '/s' : '—'} / buy ${fmtNum(p.buy)} · sell ${fmtNum(p.sell)}`;
      if (cell) cell.textContent = live;

      if (!state.running || state.dryRun) continue;

      if (!rc.enabled) {
        if (row.sellInput) setNativeValue(row.sellInput, 0);
        if (row.buyInput) setNativeValue(row.buyInput, 0);
        continue;
      }

      if (row.sellInput) setNativeValue(row.sellInput, p.sell || 0);
      if (row.buyInput) setNativeValue(row.buyInput, p.buy || 0);
    }
  }

  function tick() {
    injectBridge();

    const api = getApi();
    const ready = api && typeof api.ready === 'function' && api.ready();
    if (!ready) { renderStatusLine('Status: waiting for game globals (resources)…'); return; }

    // Re-scan periodically
    if (!tick._lastScanAt || (Date.now() - tick._lastScanAt) > 2500) {
      tick._lastScanAt = Date.now();
      const beforeSig = market.lastSig;
      scanMarket();
      if (market.lastSig !== beforeSig) rebuildTable();
    }

    if (!market.detected) {
      renderStatusLine('Status: Market table not detected. (Make sure Galactic Market is open.)');
      return;
    }

    const snap = api.snapshot ? api.snapshot() : null;
    const resIndex = buildResourceIndex(snap);

    const plan = computePlan(snap, resIndex);

    const pills = [];
    pills.push(`<span class="ttgm-badge">Market: ${market.rows.size} rows</span>`);
    pills.push(`<span class="ttgm-badge">Run checkbox: ${market.runCheckbox ? 'found' : 'missing'}</span>`);
    if (plan.fundingKnown) {
      pills.push(`<span class="ttgm-badge">Funding: ${fmtNum(plan.funding)}</span>`);
      pills.push(`<span class="ttgm-badge">${plan.fundingShort ? 'Funding: LOW' : 'Funding: OK'}</span>`);
    } else {
      pills.push(`<span class="ttgm-badge">Funding: (unknown)</span>`);
    }
    pills.push(`<span class="ttgm-badge">${state.dryRun ? 'DRY' : 'LIVE'}</span>`);
    const pillsEl = ui.body?.querySelector('#ttgm-pills');
    if (pillsEl) pillsEl.innerHTML = pills.join(' ');

    applyPlanToMarket(plan);

    const anyOrders = Array.from(plan.planned.values()).some(x => (x.buy > 0 || x.sell > 0));
    renderStatusLine(
      !state.running ? 'Status: Stopped (no writes).' :
      state.dryRun ? `Status: DRY (computed ${anyOrders ? 'orders' : 'idle'}).` :
      `Status: Running (${anyOrders ? 'writing orders' : 'idle'}).`
    );
  }

  /********************************************************************
   * Boot
   ********************************************************************/
  buildUI();
  injectBridge();
  scanMarket();
  rebuildTable();
  tick();

  setInterval(() => {
    TT.runExclusive('galacticMarket', 800, tick);
  }, clamp(toNum(state.tickMs, 650), 200, 5000));

})();
