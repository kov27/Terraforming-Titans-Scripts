// ==UserScript==
// @name         Terraforming Titans — Galactic Market Automator (v2)
// @namespace    https://terraforming.titans/
// @version      2.0.0
// @description  Auto-writes Galactic Market Buy Amount / Sell Amount inputs based on simple per-resource floors/ceilings, and can manage Market Run.
// @author       You
// @match        https://terraformingtitans.com/*
// @match        https://www.terraformingtitans.com/*
// @match        https://*.terraformingtitans.com/*
// @match        https://*.itch.io/*
// @match        https://hwcdn.net/*
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  /******************************************************************
   * Storage helpers (GM_* if available, else localStorage)
   ******************************************************************/
  const STORE_KEY = 'tt_gm_auto_v2_settings';
  const POS_KEY   = 'tt_gm_auto_v2_pos';

  const hasGM = (typeof GM_getValue === 'function') && (typeof GM_setValue === 'function');

  function loadJSON(key, fallback) {
    try {
      if (hasGM) return GM_getValue(key, fallback);
      const raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch { return fallback; }
  }

  function saveJSON(key, value) {
    try {
      if (hasGM) return GM_setValue(key, value);
      localStorage.setItem(key, JSON.stringify(value));
    } catch { /* ignore */ }
  }

  /******************************************************************
   * Number parsing (supports K/M/B/T/Qa/Qi/Sx/Sp/Oc/No/Dc and 1eX)
   ******************************************************************/
  const SUFFIX = new Map([
    ['k', 1e3], ['m', 1e6], ['b', 1e9], ['t', 1e12],
    ['qa', 1e15], ['qi', 1e18], ['sx', 1e21], ['sp', 1e24],
    ['oc', 1e27], ['no', 1e30], ['dc', 1e33],
    ['g', 1e9], // sometimes used loosely
  ]);

  function parseTTNumber(x) {
    if (x == null) return NaN;
    let s = String(x).trim();
    if (!s) return NaN;

    // Remove commas and whitespace
    s = s.replace(/,/g, '').replace(/\s+/g, '');

    // Plain number or scientific
    if (/^[+\-]?\d*\.?\d+(e[+\-]?\d+)?$/i.test(s)) {
      const v = Number(s);
      return Number.isFinite(v) ? v : NaN;
    }

    // e.g. 10.6T, 31.2B, 0.5
    const m = s.match(/^([+\-]?\d*\.?\d+(?:e[+\-]?\d+)?)([a-zA-Z]{1,2})$/);
    if (!m) return NaN;

    const base = Number(m[1]);
    if (!Number.isFinite(base)) return NaN;

    const suf = m[2].toLowerCase();
    const mul = SUFFIX.get(suf);
    if (!mul) return NaN;

    const v = base * mul;
    return Number.isFinite(v) ? v : NaN;
  }

  function clamp(n, lo, hi) {
    n = Number(n);
    if (!Number.isFinite(n)) return lo;
    return Math.max(lo, Math.min(hi, n));
  }

  function fmtInt(n) {
    n = Number(n);
    if (!Number.isFinite(n) || n <= 0) return '0';
    // Market inputs seem to want plain numeric strings.
    // Floor to avoid oscillation / fractional weirdness.
    return String(Math.floor(n));
  }

  /******************************************************************
   * DOM utilities
   ******************************************************************/
  const HOST_ID = 'tt-gm-auto-v2-host';

  function visible(el) {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function normText(s) {
    return String(s || '').replace(/\s+/g, ' ').trim();
  }

  function setNativeValue(input, valueStr) {
    if (!input) return;
    const last = input.value;
    input.value = valueStr;
    const ev1 = new Event('input', { bubbles: true });
    const ev2 = new Event('change', { bubbles: true });
    // Try to trigger reactive listeners
    if (last !== valueStr) {
      input.dispatchEvent(ev1);
      input.dispatchEvent(ev2);
    }
  }

  function findByText(tagList, needle, maxLen = 200) {
    const tags = tagList.split(',').map(s => s.trim());
    const els = [];
    for (const t of tags) {
      els.push(...document.querySelectorAll(t));
    }
    const lowNeedle = needle.toLowerCase();
    const hits = [];
    for (const el of els) {
      if (!visible(el)) continue;
      const t = normText(el.textContent);
      if (!t || t.length > maxLen) continue;
      if (t.toLowerCase().includes(lowNeedle)) hits.push(el);
    }
    return hits;
  }

  /******************************************************************
   * Market table scanning (NEW UI: Buy Amount / Sell Amount inputs)
   ******************************************************************/
  function scanMarketFromTable() {
    const tables = Array.from(document.querySelectorAll('table')).filter(visible);
    for (const table of tables) {
      const ths = Array.from(table.querySelectorAll('thead th')).map(th => normText(th.textContent));
      const joined = ths.join(' | ').toLowerCase();
      if (
        joined.includes('sell amount') &&
        joined.includes('buy amount') &&
        joined.includes('sell price') &&
        joined.includes('buy price')
      ) {
        // Map header -> index
        const map = new Map();
        ths.forEach((t, i) => map.set(t.toLowerCase(), i));

        const rows = Array.from(table.querySelectorAll('tbody tr')).filter(visible);
        const out = new Map();

        for (const tr of rows) {
          const tds = Array.from(tr.querySelectorAll('td'));
          if (!tds.length) continue;

          const name = normText(tds[0]?.textContent);
          if (!name) continue;

          const sellAmtIdx = [...map.entries()].find(([k]) => k.includes('sell amount'))?.[1];
          const buyAmtIdx  = [...map.entries()].find(([k]) => k.includes('buy amount'))?.[1];
          const sellPxIdx  = [...map.entries()].find(([k]) => k.includes('sell price'))?.[1];
          const buyPxIdx   = [...map.entries()].find(([k]) => k.includes('buy price'))?.[1];

          const sellInput = (sellAmtIdx != null) ? tds[sellAmtIdx]?.querySelector('input') : null;
          const buyInput  = (buyAmtIdx  != null) ? tds[buyAmtIdx]?.querySelector('input')  : null;

          const sellPriceTxt = (sellPxIdx != null) ? normText(tds[sellPxIdx]?.textContent) : '';
          const buyPriceTxt  = (buyPxIdx  != null) ? normText(tds[buyPxIdx]?.textContent)  : '';

          const sellPrice = parseTTNumber(sellPriceTxt);
          const buyPrice  = parseTTNumber(buyPriceTxt);

          // Some builds show plain "0.5" etc; parseTTNumber handles.
          out.set(name, {
            name,
            tr,
            sellInput,
            buyInput,
            sellPrice: Number.isFinite(sellPrice) ? sellPrice : NaN,
            buyPrice:  Number.isFinite(buyPrice)  ? buyPrice  : NaN,
          });
        }

        return { mode: 'table', table, rows: out };
      }
    }
    return null;
  }

  // Fallback (if the UI stops using <table> someday)
  function scanMarketFallbackGrid() {
    // Find a container that contains the key column labels
    const candidates = Array.from(document.querySelectorAll('div,section,main')).filter(visible);
    let best = null;
    let bestScore = -1;

    for (const el of candidates) {
      const t = normText(el.textContent).toLowerCase();
      if (!t.includes('sell amount') || !t.includes('buy amount')) continue;
      if (!t.includes('sell price') || !t.includes('buy price')) continue;
      const inputCount = el.querySelectorAll('input').length;
      if (inputCount < 6) continue;
      const score = inputCount;
      if (score > bestScore) { bestScore = score; best = el; }
    }
    if (!best) return null;

    // Try to locate row containers: elements containing 2 inputs + a resource-ish label
    const out = new Map();
    const rowCands = Array.from(best.querySelectorAll('div,tr,li')).filter(visible);

    for (const row of rowCands) {
      const inputs = row.querySelectorAll('input');
      if (inputs.length < 2) continue;

      const txt = normText(row.textContent);
      if (!txt || txt.length > 160) continue;

      // Guess the name: first word token
      const name = txt.split(' ')[0];
      if (!name || /\d/.test(name)) continue;

      out.set(name, {
        name,
        tr: row,
        sellInput: inputs[0],
        buyInput: inputs[1],
        sellPrice: NaN,
        buyPrice: NaN,
      });
    }

    return out.size ? { mode: 'grid', table: best, rows: out } : null;
  }

  function findMarketRunCheckbox() {
    // In the screenshot it appears as a checkbox labeled "Run" under the red bar.
    // Prefer a label that contains an input + the word Run.
    const labels = Array.from(document.querySelectorAll('label')).filter(visible);
    for (const lab of labels) {
      const t = normText(lab.textContent).toLowerCase();
      if (t === 'run' || t.includes(' run')) {
        const cb = lab.querySelector('input[type="checkbox"]');
        if (cb) return cb;
      }
    }

    // Fallback: any checkbox near the text "Run"
    const runTextNodes = findByText('div,span,p', 'Run', 40);
    for (const n of runTextNodes) {
      const parent = n.closest('div,section') || n.parentElement;
      if (!parent) continue;
      const cb = parent.querySelector('input[type="checkbox"]');
      if (cb) return cb;
    }
    return null;
  }

  /******************************************************************
   * Sidebar scanning (reads current amount/cap + funding)
   ******************************************************************/
  function pickBestRowForLabel(label) {
    const low = label.toLowerCase();
    const pool = Array.from(document.querySelectorAll('div,span,p,td')).filter(visible);

    let best = null;
    let bestScore = Infinity;

    // We want small “row-like” elements that start with the label and contain digits.
    for (const el of pool) {
      if (el.id === HOST_ID) continue;
      if (el.closest(`#${HOST_ID}`)) continue;

      const t = normText(el.textContent);
      if (!t) continue;

      const tl = t.toLowerCase();
      if (!tl.startsWith(low)) continue;
      if (!/\d/.test(t)) continue;
      if (t.length > 90) continue;

      const r = el.getBoundingClientRect();
      const area = r.width * r.height;

      // Heuristics: shorter text + smaller area is better
      const score = (t.length * 3) + (area / 500);

      if (score < bestScore) {
        bestScore = score;
        best = el;
      }
    }
    return best;
  }

  function parseRowValueCap(text, label) {
    // Expect something like:
    // "Metal 10.6T / 10.6T"
    // "Android 2.2k / 3.2k"
    // "Funding 54.8k"
    const t = normText(text);
    const rest = t.slice(label.length).trim();

    // Pull first two numeric-ish tokens (with optional suffix)
    const m = rest.match(/([+\-]?\d[\d,.]*(?:e[+\-]?\d+)?(?:\s*[a-zA-Z]{1,2})?)(?:\s*\/\s*([+\-]?\d[\d,.]*(?:e[+\-]?\d+)?(?:\s*[a-zA-Z]{1,2})?))?/);
    if (!m) return { cur: NaN, cap: NaN };

    const cur = parseTTNumber(m[1].replace(/\s+/g,''));
    const cap = m[2] ? parseTTNumber(m[2].replace(/\s+/g,'')) : NaN;
    return { cur, cap };
  }

  /******************************************************************
   * State + Settings
   ******************************************************************/
  const DEFAULTS = {
    enabled: false,
    dryRun: false,
    tickMs: 650,

    // Funding controls
    minFunding: 0,       // never spend below this
    desiredFunding: 0,   // if funding < desired, restrict buys to "critical only"
    manageMarketRun: true,

    // Per-resource policy (created on Scan)
    resources: {
      // name: { use: true, buyFloorPct: 20, sellCeilPct: 95, hardMin: 0, prio: 5 }
    },

    ui: {
      minimized: false,
      showDebug: false
    }
  };

  const state = {
    settings: mergeDeep(structuredClone(DEFAULTS), loadJSON(STORE_KEY, {})),
    market: {
      detected: false,
      rows: new Map(),
      mode: null,
      runCheckbox: null
    },
    sidebar: {
      elByLabel: new Map()
    },
    last: {
      status: 'Idle. Open Galactic Market then click Scan.',
      debug: ''
    },
    timers: {
      loop: null
    }
  };

  function mergeDeep(a, b) {
    if (!b || typeof b !== 'object') return a;
    for (const k of Object.keys(b)) {
      if (b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) {
        a[k] = mergeDeep(a[k] || {}, b[k]);
      } else {
        a[k] = b[k];
      }
    }
    return a;
  }

  function persist() {
    saveJSON(STORE_KEY, state.settings);
  }

  /******************************************************************
   * Scan (Market + Sidebar)
   ******************************************************************/
  function scanAll() {
    // Market
    const m1 = scanMarketFromTable();
    const m2 = m1 ? null : scanMarketFallbackGrid();
    const found = m1 || m2;

    state.market.rows = found ? found.rows : new Map();
    state.market.mode = found ? found.mode : null;
    state.market.detected = !!found;

    // Run checkbox
    state.market.runCheckbox = findMarketRunCheckbox();

    // Sidebar rows for funding + each market resource
    state.sidebar.elByLabel.clear();

    const names = Array.from(state.market.rows.keys());
    const need = ['Funding', ...names];

    for (const lab of need) {
      const el = pickBestRowForLabel(lab);
      if (el) state.sidebar.elByLabel.set(lab, el);
    }

    // Ensure we have per-resource config
    for (const name of names) {
      if (!state.settings.resources[name]) {
        state.settings.resources[name] = {
          use: true,
          buyFloorPct: 20,
          sellCeilPct: 95,
          hardMin: 0,
          prio: 5
        };
      }
    }

    persist();
    rebuildPolicyTable();

    const okRows = state.market.rows.size;
    state.last.status = state.market.detected
      ? `Scan OK: ${okRows} market rows detected (${state.market.mode}).`
      : 'Scan FAILED: Market table not detected. Make sure the Galactic Market panel is open.';

    updateStatus();
  }

  function readFunding() {
    const el = state.sidebar.elByLabel.get('Funding');
    if (!el) return NaN;
    const { cur } = parseRowValueCap(el.textContent, 'Funding');
    return cur;
  }

  function readResource(name) {
    const el = state.sidebar.elByLabel.get(name);
    if (!el) return { cur: NaN, cap: NaN };
    return parseRowValueCap(el.textContent, name);
  }

  /******************************************************************
   * Planning
   ******************************************************************/
  function computePlan() {
    const s = state.settings;
    const funding = readFunding();
    const fundingKnown = Number.isFinite(funding);

    const buys = [];
    const sells = [];

    for (const [name, row] of state.market.rows.entries()) {
      const cfg = s.resources[name];
      if (!cfg || !cfg.use) {
        buys.push({ name, amt: 0 });
        sells.push({ name, amt: 0 });
        continue;
      }

      const { cur, cap } = readResource(name);
      const curKnown = Number.isFinite(cur);
      const capKnown = Number.isFinite(cap) && cap > 0;

      const hardMin = Math.max(0, Number(cfg.hardMin || 0));
      const buyFloorPct = clamp(cfg.buyFloorPct, 0, 100);
      const sellCeilPct = clamp(cfg.sellCeilPct, 0, 100);

      const floorVal = capKnown ? Math.max(hardMin, cap * (buyFloorPct / 100)) : hardMin;
      const ceilVal  = capKnown ? Math.max(floorVal, cap * (sellCeilPct / 100)) : Infinity;

      const needBuy = (curKnown && cur < floorVal) ? (floorVal - cur) : 0;
      const excessSell = (curKnown && cur > ceilVal && Number.isFinite(ceilVal)) ? (cur - ceilVal) : 0;

      const prio = clamp(cfg.prio, 1, 9);

      buys.push({
        name,
        need: Math.max(0, needBuy),
        prio,
        price: Number.isFinite(row.buyPrice) ? row.buyPrice : NaN,
        critical: curKnown && cur < hardMin
      });

      sells.push({
        name,
        excess: Math.max(0, excessSell),
        prio,
        price: Number.isFinite(row.sellPrice) ? row.sellPrice : NaN
      });
    }

    // Budget logic
    const minFunding = Math.max(0, Number(s.minFunding || 0));
    const desiredFunding = Math.max(0, Number(s.desiredFunding || 0));

    // If under desired, only allow "critical" buys (below hardMin). Otherwise allow normal buys.
    let budget = Infinity;
    if (fundingKnown) {
      const spendable = Math.max(0, funding - minFunding);
      budget = spendable;

      if (desiredFunding > 0 && funding < desiredFunding) {
        // "cash up" mode
        budget = 0;
      }
    }

    // Sort buys by priority (low first), then critical, then need
    buys.sort((a, b) =>
      (a.prio - b.prio) ||
      ((b.critical ? 1 : 0) - (a.critical ? 1 : 0)) ||
      (b.need - a.need)
    );

    const buyOut = new Map();
    let remaining = budget;

    for (const b of buys) {
      let amt = 0;

      if (b.need <= 0) {
        amt = 0;
      } else if (remaining <= 0) {
        // If in "cash up" mode, allow only critical buys
        if (b.critical && fundingKnown) {
          // minimal “unstuck” buy of 1 if affordable by minFunding buffer logic
          const px = Number.isFinite(b.price) && b.price > 0 ? b.price : NaN;
          if (Number.isFinite(px)) {
            const spendable = Math.max(0, funding - minFunding);
            amt = Math.floor(spendable / px) >= 1 ? 1 : 0;
          } else {
            amt = 0;
          }
        } else {
          amt = 0;
        }
      } else {
        // Normal mode
        const px = Number.isFinite(b.price) && b.price > 0 ? b.price : NaN;
        if (Number.isFinite(px)) {
          amt = Math.min(b.need, remaining / px);
          amt = Math.floor(Math.max(0, amt));
          remaining -= amt * px;
        } else {
          // Unknown price: still buy a small chunk (safe)
          amt = Math.floor(Math.min(b.need, 10));
        }
      }

      buyOut.set(b.name, amt);
    }

    // Sells: don’t need funding. Sell excess for all enabled resources.
    // Sort sells so high prio sells go first (low number = higher prio), but we’ll write all anyway.
    sells.sort((a, b) => (a.prio - b.prio) || (b.excess - a.excess));

    const sellOut = new Map();
    for (const x of sells) {
      sellOut.set(x.name, Math.floor(Math.max(0, x.excess || 0)));
    }

    // Build debug line
    const totalBuyCost = (() => {
      let sum = 0;
      for (const [name, amt] of buyOut.entries()) {
        const r = state.market.rows.get(name);
        const px = r && Number.isFinite(r.buyPrice) ? r.buyPrice : NaN;
        if (Number.isFinite(px)) sum += amt * px;
      }
      return sum;
    })();

    const totalSellRev = (() => {
      let sum = 0;
      for (const [name, amt] of sellOut.entries()) {
        const r = state.market.rows.get(name);
        const px = r && Number.isFinite(r.sellPrice) ? r.sellPrice : NaN;
        if (Number.isFinite(px)) sum += amt * px;
      }
      return sum;
    })();

    return {
      funding,
      fundingKnown,
      budget,
      remaining,
      buyOut,
      sellOut,
      totals: { buyCost: totalBuyCost, sellRev: totalSellRev }
    };
  }

  /******************************************************************
   * Apply plan to the Market inputs
   ******************************************************************/
  function applyPlan(plan) {
    const s = state.settings;

    if (!state.market.detected || state.market.rows.size === 0) {
      state.last.status = 'Market not detected. Open Galactic Market and click Scan.';
      updateStatus();
      return;
    }

    // Manage Market Run checkbox if requested
    if (s.manageMarketRun && state.market.runCheckbox) {
      if (!state.market.runCheckbox.checked) {
        state.market.runCheckbox.click();
      }
    }

    // Write inputs
    let wrote = 0;

    for (const [name, row] of state.market.rows.entries()) {
      const buyAmt  = plan.buyOut.get(name)  ?? 0;
      const sellAmt = plan.sellOut.get(name) ?? 0;

      if (!row.buyInput || !row.sellInput) continue;

      if (!s.dryRun) {
        setNativeValue(row.buyInput, fmtInt(buyAmt));
        setNativeValue(row.sellInput, fmtInt(sellAmt));
      }
      wrote++;
    }

    const fTxt = plan.fundingKnown ? `Funding: ${plan.funding.toFixed(0)}` : 'Funding: ?';
    const rowsTxt = `Market: ${state.market.rows.size} rows`;
    const modeTxt = state.market.mode ? `(${state.market.mode})` : '';
    const dryTxt = s.dryRun ? 'DRY' : 'LIVE';
    const net = plan.totals.buyCost - plan.totals.sellRev;

    state.last.status = `${dryTxt} • ${rowsTxt} ${modeTxt} • wrote ${wrote} • ${fTxt} • net=${net.toFixed(1)}`;
    if (state.settings.ui.showDebug) {
      state.last.debug =
        `budget=${plan.budget}\nremaining=${plan.remaining}\n` +
        `buyCost=${plan.totals.buyCost}\nsellRev=${plan.totals.sellRev}\n` +
        `runCB=${!!state.market.runCheckbox}\n`;
    } else {
      state.last.debug = '';
    }

    updateStatus();
  }

  function clearOrders() {
    if (!state.market.detected || state.market.rows.size === 0) return;
    for (const row of state.market.rows.values()) {
      if (row.buyInput) setNativeValue(row.buyInput, '0');
      if (row.sellInput) setNativeValue(row.sellInput, '0');
    }
    state.last.status = 'Cleared market orders (set all Buy/Sell Amount to 0).';
    updateStatus();
  }

  /******************************************************************
   * Loop
   ******************************************************************/
  function startLoop() {
    stopLoop();
    state.settings.enabled = true;
    persist();
    updateRunButton();

    state.timers.loop = setInterval(() => {
      if (!state.market.detected || state.market.rows.size === 0) {
        // Try lightweight re-scan occasionally while running
        scanAll();
        return;
      }
      const plan = computePlan();
      applyPlan(plan);
    }, clamp(state.settings.tickMs, 100, 5000));
  }

  function stopLoop() {
    if (state.timers.loop) clearInterval(state.timers.loop);
    state.timers.loop = null;
    state.settings.enabled = false;
    persist();
    updateRunButton();
  }

  function toggleRun() {
    if (state.settings.enabled) stopLoop();
    else startLoop();
  }

  /******************************************************************
   * UI (worker-allocator-ish: draggable, minimizable)
   ******************************************************************/
  let ui = {
    host: null,
    shadow: null,
    els: {}
  };

  function injectUI() {
    if (document.getElementById(HOST_ID)) return;

    const host = document.createElement('div');
    host.id = HOST_ID;
    host.style.position = 'fixed';
    host.style.zIndex = '999999';
    host.style.right = '18px';
    host.style.bottom = '18px';
    host.style.width = '720px';
    host.style.userSelect = 'none';

    // Restore position
    const pos = loadJSON(POS_KEY, null);
    if (pos && Number.isFinite(pos.x) && Number.isFinite(pos.y)) {
      host.style.left = `${pos.x}px`;
      host.style.top = `${pos.y}px`;
      host.style.right = 'auto';
      host.style.bottom = 'auto';
    }

    const shadow = host.attachShadow({ mode: 'open' });

    const style = document.createElement('style');
    style.textContent = `
      .panel{
        background: rgba(20, 16, 34, 0.86);
        border: 1px solid rgba(180, 160, 255, 0.25);
        border-radius: 14px;
        box-shadow: 0 14px 34px rgba(0,0,0,0.45);
        color: #ebe9ff;
        font: 12px/1.25 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        overflow: hidden;
      }
      .hdr{
        display:flex;
        align-items:center;
        gap:10px;
        padding:10px 12px;
        background: rgba(255,255,255,0.06);
        border-bottom: 1px solid rgba(255,255,255,0.10);
        cursor: move;
      }
      .title{
        font-weight:800;
        letter-spacing:0.2px;
      }
      .sp{ flex:1; }
      .pill{
        padding: 4px 10px;
        border-radius: 999px;
        border: 1px solid rgba(255,255,255,0.14);
        background: rgba(0,0,0,0.20);
        font-weight: 700;
      }
      .btn{
        background: rgba(255,255,255,0.08);
        border: 1px solid rgba(255,255,255,0.14);
        color:#ebe9ff;
        border-radius: 10px;
        padding: 6px 10px;
        cursor:pointer;
        font-weight: 700;
      }
      .btn:hover{ background: rgba(255,255,255,0.12); }
      .btn.danger{ border-color: rgba(255,120,120,0.35); }
      .btn.good{ border-color: rgba(120,255,160,0.25); }

      .body{ padding: 10px 12px; }
      .grid{
        display:grid;
        grid-template-columns: 120px 90px 110px 110px 1fr;
        gap: 8px 10px;
        align-items:center;
        margin-bottom: 10px;
      }
      label{ opacity: 0.95; }
      input[type="text"]{
        width: 100%;
        background: rgba(0,0,0,0.25);
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 10px;
        padding: 6px 8px;
        color:#ebe9ff;
        outline:none;
      }
      input[type="checkbox"]{ transform: translateY(1px); }

      table{
        width:100%;
        border-collapse: collapse;
        margin-top: 8px;
      }
      th, td{
        padding: 7px 8px;
        border-bottom: 1px solid rgba(255,255,255,0.08);
        white-space: nowrap;
      }
      th{
        text-align:left;
        font-weight: 900;
        opacity: 0.95;
      }
      td small{ opacity: 0.8; }
      .num{ width: 88px; }
      .prio{ width: 52px; text-align:center; }
      .foot{
        display:flex;
        gap:10px;
        align-items:center;
        padding: 10px 12px;
        border-top: 1px solid rgba(255,255,255,0.10);
        background: rgba(255,255,255,0.04);
      }
      .status{
        flex:1;
        opacity: 0.92;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .debug{
        padding: 10px 12px;
        opacity: 0.9;
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", monospace;
        white-space: pre-wrap;
      }
      .minBody{ display:none; }
    `;

    const panel = document.createElement('div');
    panel.className = 'panel';

    panel.innerHTML = `
      <div class="hdr" data-drag="1">
        <div class="title">Galactic Market Automator</div>
        <div class="pill" id="runPill">${state.settings.enabled ? 'Running' : 'Stopped'}</div>
        <div class="sp"></div>
        <button class="btn" id="scanBtn">Scan</button>
        <button class="btn danger" id="clearBtn">Clear Orders</button>
        <button class="btn" id="minBtn">${state.settings.ui.minimized ? 'Expand' : 'Minimize'}</button>
      </div>

      <div class="body" id="bodyWrap">
        <div class="grid">
          <label>Tick (ms)</label>
          <input type="text" id="tickMs" value="${state.settings.tickMs}">
          <label><input type="checkbox" id="dryRun" ${state.settings.dryRun ? 'checked' : ''}> Dry-run</label>
          <label><input type="checkbox" id="manageRun" ${state.settings.manageMarketRun ? 'checked' : ''}> Manage Market Run</label>
          <button class="btn good" id="toggleBtn">${state.settings.enabled ? 'Pause' : 'Start'}</button>

          <label>Min funding</label>
          <input type="text" id="minFunding" value="${state.settings.minFunding}">
          <label>Desired funding</label>
          <input type="text" id="desiredFunding" value="${state.settings.desiredFunding}">
          <label><input type="checkbox" id="dbg" ${state.settings.ui.showDebug ? 'checked' : ''}> Debug</label>
        </div>

        <div style="opacity:0.85; margin-bottom:6px;">
          Floors/Ceilings are <b>% of your cap</b> from the left sidebar (Hard min is absolute).
        </div>

        <div id="policyWrap"></div>
      </div>

      <div class="foot">
        <div class="status" id="statusLine"></div>
      </div>

      <div class="debug" id="debugBox" style="display:${state.settings.ui.showDebug ? 'block' : 'none'}"></div>
    `;

    shadow.appendChild(style);
    shadow.appendChild(panel);
    document.documentElement.appendChild(host);

    ui.host = host;
    ui.shadow = shadow;
    ui.els.runPill = shadow.getElementById('runPill');
    ui.els.statusLine = shadow.getElementById('statusLine');
    ui.els.debugBox = shadow.getElementById('debugBox');
    ui.els.policyWrap = shadow.getElementById('policyWrap');
    ui.els.bodyWrap = shadow.getElementById('bodyWrap');

    // Minimized state
    applyMinimized();

    // Wire controls
    shadow.getElementById('scanBtn').addEventListener('click', () => scanAll());
    shadow.getElementById('clearBtn').addEventListener('click', () => clearOrders());
    shadow.getElementById('toggleBtn').addEventListener('click', () => toggleRun());

    shadow.getElementById('minBtn').addEventListener('click', () => {
      state.settings.ui.minimized = !state.settings.ui.minimized;
      persist();
      applyMinimized();
    });

    shadow.getElementById('tickMs').addEventListener('change', (e) => {
      state.settings.tickMs = clamp(parseTTNumber(e.target.value), 100, 5000);
      persist();
      if (state.settings.enabled) startLoop(); // restart with new tick
    });

    shadow.getElementById('dryRun').addEventListener('change', (e) => {
      state.settings.dryRun = !!e.target.checked;
      persist();
      updateStatus();
    });

    shadow.getElementById('manageRun').addEventListener('change', (e) => {
      state.settings.manageMarketRun = !!e.target.checked;
      persist();
    });

    shadow.getElementById('minFunding').addEventListener('change', (e) => {
      state.settings.minFunding = Math.max(0, parseTTNumber(e.target.value));
      persist();
    });

    shadow.getElementById('desiredFunding').addEventListener('change', (e) => {
      state.settings.desiredFunding = Math.max(0, parseTTNumber(e.target.value));
      persist();
    });

    shadow.getElementById('dbg').addEventListener('change', (e) => {
      state.settings.ui.showDebug = !!e.target.checked;
      persist();
      ui.els.debugBox.style.display = state.settings.ui.showDebug ? 'block' : 'none';
      updateStatus();
    });

    // Dragging
    makeDraggable(shadow.querySelector('[data-drag="1"]'), host);

    // Initial render
    rebuildPolicyTable();
    updateStatus();
    updateRunButton();
  }

  function applyMinimized() {
    if (!ui.els.bodyWrap) return;
    ui.els.bodyWrap.style.display = state.settings.ui.minimized ? 'none' : 'block';
    const minBtn = ui.shadow.getElementById('minBtn');
    if (minBtn) minBtn.textContent = state.settings.ui.minimized ? 'Expand' : 'Minimize';
  }

  function makeDraggable(handle, host) {
    if (!handle || !host) return;

    let dragging = false;
    let sx = 0, sy = 0;
    let ox = 0, oy = 0;

    handle.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      handle.setPointerCapture(e.pointerId);
      sx = e.clientX;
      sy = e.clientY;

      const r = host.getBoundingClientRect();
      ox = r.left;
      oy = r.top;

      host.style.right = 'auto';
      host.style.bottom = 'auto';
      host.style.left = `${ox}px`;
      host.style.top = `${oy}px`;
    });

    handle.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - sx;
      const dy = e.clientY - sy;
      const x = Math.max(0, ox + dx);
      const y = Math.max(0, oy + dy);
      host.style.left = `${x}px`;
      host.style.top = `${y}px`;
    });

    handle.addEventListener('pointerup', (e) => {
      if (!dragging) return;
      dragging = false;
      try {
        const r = host.getBoundingClientRect();
        saveJSON(POS_KEY, { x: r.left, y: r.top });
      } catch { /* ignore */ }
    });
  }

  function rebuildPolicyTable() {
    if (!ui.els.policyWrap) return;

    const names = Array.from(state.market.rows.keys()).sort((a,b) => a.localeCompare(b));
    if (!names.length) {
      ui.els.policyWrap.innerHTML = `
        <div style="opacity:0.85; padding:8px 2px;">
          No market resources detected yet. Open the <b>Galactic Market</b> panel, then click <b>Scan</b>.
        </div>
      `;
      return;
    }

    const rowsHtml = names.map(name => {
      const cfg = state.settings.resources[name] || { use:true, buyFloorPct:20, sellCeilPct:95, hardMin:0, prio:5 };
      return `
        <tr data-name="${name}">
          <td><label><input type="checkbox" data-k="use" ${cfg.use ? 'checked' : ''}> ${name}</label></td>
          <td><input class="num" type="text" data-k="buyFloorPct" value="${cfg.buyFloorPct}"></td>
          <td><input class="num" type="text" data-k="sellCeilPct" value="${cfg.sellCeilPct}"></td>
          <td><input class="num" type="text" data-k="hardMin" value="${cfg.hardMin}"></td>
          <td><input class="prio" type="text" data-k="prio" value="${cfg.prio}"></td>
          <td><small class="live" data-k="live">—</small></td>
        </tr>
      `;
    }).join('');

    ui.els.policyWrap.innerHTML = `
      <table>
        <thead>
          <tr>
            <th>Use</th>
            <th>Buy floor (% cap)</th>
            <th>Sell ceil (% cap)</th>
            <th>Hard min</th>
            <th>Prio</th>
            <th>Live (cur/cap)</th>
          </tr>
        </thead>
        <tbody>
          ${rowsHtml}
        </tbody>
      </table>
    `;

    // Wire inputs
    const tbody = ui.els.policyWrap.querySelector('tbody');
    tbody.addEventListener('change', (e) => {
      const tr = e.target.closest('tr[data-name]');
      if (!tr) return;
      const name = tr.getAttribute('data-name');
      const key = e.target.getAttribute('data-k');
      if (!key) return;

      const cfg = state.settings.resources[name] || (state.settings.resources[name] = {});
      if (e.target.type === 'checkbox') cfg[key] = !!e.target.checked;
      else cfg[key] = parseTTNumber(e.target.value);

      // Basic clamps
      cfg.buyFloorPct = clamp(cfg.buyFloorPct, 0, 100);
      cfg.sellCeilPct = clamp(cfg.sellCeilPct, 0, 100);
      cfg.hardMin = Math.max(0, Number(cfg.hardMin || 0));
      cfg.prio = clamp(cfg.prio, 1, 9);

      persist();
    });
  }

  function updateRunButton() {
    if (!ui.shadow) return;
    const toggleBtn = ui.shadow.getElementById('toggleBtn');
    if (toggleBtn) toggleBtn.textContent = state.settings.enabled ? 'Pause' : 'Start';
    if (ui.els.runPill) ui.els.runPill.textContent = state.settings.enabled ? 'Running' : 'Stopped';
  }

  function updateStatus() {
    if (!ui.els.statusLine) return;

    // Update live cur/cap display in table
    if (ui.els.policyWrap && state.market.rows.size) {
      const trs = ui.els.policyWrap.querySelectorAll('tr[data-name]');
      for (const tr of trs) {
        const name = tr.getAttribute('data-name');
        const live = tr.querySelector('small.live');
        if (!live) continue;
        const { cur, cap } = readResource(name);
        if (Number.isFinite(cur) && Number.isFinite(cap)) live.textContent = `${cur.toFixed(2)} / ${cap.toFixed(2)}`;
        else if (Number.isFinite(cur)) live.textContent = `${cur.toFixed(2)}`;
        else live.textContent = '—';
      }
    }

    ui.els.statusLine.textContent = state.last.status || '';
    if (ui.els.debugBox) ui.els.debugBox.textContent = state.last.debug || '';
  }

  /******************************************************************
   * Init
   ******************************************************************/
  function boot() {
    injectUI();
    // Don’t auto-scan forever; user will click Scan when market is open.
    // But do a soft scan once after load in case they’re already on Market.
    setTimeout(() => scanAll(), 1200);

    // Resume if enabled (rare, but supported)
    if (state.settings.enabled) startLoop();
  }

  boot();

})();
