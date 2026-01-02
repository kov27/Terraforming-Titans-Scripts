// ==UserScript==
// @name         Terraforming Titans Growth Optimizer (Land% Ecumenopolis Planner) [Bridge Fix]
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.1.1
// @description  Overlay that estimates the fastest route to a Land%-sized ecumenopolis and full colonist+android occupancy. Includes page-bridge so it can read TT globals.
// @author       kov27 (ChatGPT-assisted)
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_addStyle
// ==/UserScript==

(function () {
  'use strict';

  /********************************************************************
   * PAGE BRIDGE (critical)
   * TT uses top-level `let colonies`, `let populationModule`, etc.
   * Userscripts cannot access global lexical bindings, only window props.
   * This bridge runs in page context and exposes getters on window.
   ********************************************************************/
  function injectBridge() {
    const BRIDGE_ID = 'ttgo-bridge-injected';
    if (document.getElementById(BRIDGE_ID)) return;

    const code = `
(() => {
  try {
    if (window.__TTGO_BRIDGE_OK__) return;
    window.__TTGO_BRIDGE_OK__ = true;

    const def = (name, getter, setter) => {
      try {
        const d = Object.getOwnPropertyDescriptor(window, name);
        if (d && (d.get || d.value !== undefined)) return;
        Object.defineProperty(window, name, { get: getter, set: setter, configurable: true });
      } catch (e) {}
    };

    // Safe getters using typeof so we never throw ReferenceError
    def('colonies',
      () => (typeof colonies !== 'undefined' ? colonies : undefined),
      (v) => { try { colonies = v; } catch (e) {} }
    );

    def('populationModule',
      () => (typeof populationModule !== 'undefined' ? populationModule : undefined),
      (v) => { try { populationModule = v; } catch (e) {} }
    );

    def('researchManager',
      () => (typeof researchManager !== 'undefined' ? researchManager : undefined),
      (v) => { try { researchManager = v; } catch (e) {} }
    );

    def('terraforming',
      () => (typeof terraforming !== 'undefined' ? terraforming : undefined),
      (v) => { try { terraforming = v; } catch (e) {} }
    );

    def('structures',
      () => (typeof structures !== 'undefined' ? structures : undefined),
      (v) => { try { structures = v; } catch (e) {} }
    );

    // resources + buildings are already exposed by TT via defineProperty(globalThis,...)
    // but keeping them here doesn't hurt if future builds change.
    def('resources',
      () => (typeof resources !== 'undefined' ? resources : undefined),
      (v) => { try { resources = v; } catch (e) {} }
    );

    def('buildings',
      () => (typeof buildings !== 'undefined' ? buildings : undefined),
      (v) => { try { buildings = v; } catch (e) {} }
    );
  } catch (e) {}
})();
`;
    const s = document.createElement('script');
    s.id = BRIDGE_ID;
    s.textContent = code;
    (document.documentElement || document.head || document.body).appendChild(s);
    s.remove();
  }

  injectBridge();

  /********************************************************************
   * Storage helpers (GM_* with localStorage fallback)
   ********************************************************************/
  const STORE_PREFIX = 'TTGO:';
  const hasGMGet = typeof GM_getValue === 'function';
  const hasGMSet = typeof GM_setValue === 'function';

  function loadSetting(key, def) {
    try { if (hasGMGet) return GM_getValue(STORE_PREFIX + key, def); } catch (_) {}
    try {
      const raw = localStorage.getItem(STORE_PREFIX + key);
      return raw == null ? def : JSON.parse(raw);
    } catch (_) { return def; }
  }

  function saveSetting(key, val) {
    try { if (hasGMSet) return GM_setValue(STORE_PREFIX + key, val); } catch (_) {}
    try { localStorage.setItem(STORE_PREFIX + key, JSON.stringify(val)); } catch (_) {}
  }

  /********************************************************************
   * Globals access (use unsafeWindow if present)
   ********************************************************************/
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function getGameRefs() {
    return {
      resources: W.resources,
      colonies: W.colonies,
      populationModule: W.populationModule,
      researchManager: W.researchManager,
      terraforming: W.terraforming,
      formatNumberFn: typeof W.formatNumber === 'function' ? W.formatNumber : null,
      bridgeOk: !!W.__TTGO_BRIDGE_OK__,
    };
  }

  /********************************************************************
   * Config / State
   ********************************************************************/
  const PANEL_ID = 'ttgo-panel';
  const UPDATE_MS = 1000;

  const state = {
    landPct: clampNumber(Number(loadSetting('landPct', 30)), 0, 100),
    expandedStatus: Boolean(loadSetting('expandedStatus', true)),
    expandedPlan: Boolean(loadSetting('expandedPlan', true)),
    minimized: Boolean(loadSetting('minimized', false)),
    hidden: Boolean(loadSetting('hidden', false)),
  };

  /********************************************************************
   * CSS
   ********************************************************************/
  const css = `
#${PANEL_ID}{
  position: fixed;
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: 420px;
  z-index: 999999;
  display: flex;
  flex-direction: column;
  border-radius: 14px;
  border: 1px solid rgba(255,255,255,0.10);
  background: rgba(34, 39, 46, 0.94);
  box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  color: rgba(255,255,255,0.92);
  font-family: system-ui, -apple-system, Segoe UI, Roboto, Helvetica, Arial, sans-serif;
  font-size: 12.5px;
  line-height: 1.25;
  overflow: hidden;
}
#${PANEL_ID}.ttgo-hidden{ display:none; }
#${PANEL_ID}.ttgo-minimized{ height:auto; bottom:auto; }

#${PANEL_ID} .ttgo-header{
  display:flex; align-items:center; justify-content:space-between;
  padding:10px 10px 8px 12px;
  border-bottom:1px solid rgba(255,255,255,0.08);
  background:rgba(255,255,255,0.03);
}
#${PANEL_ID} .ttgo-title{ display:flex; flex-direction:column; gap:2px; }
#${PANEL_ID} .ttgo-title strong{ font-size:13.5px; letter-spacing:.2px; }
#${PANEL_ID} .ttgo-sub{ opacity:.75; font-size:11.5px; }

#${PANEL_ID} .ttgo-header button{
  appearance:none;
  border:1px solid rgba(255,255,255,0.12);
  background:rgba(255,255,255,0.06);
  color:rgba(255,255,255,0.92);
  border-radius:10px;
  padding:6px 9px;
  cursor:pointer;
  font-size:12px;
}
#${PANEL_ID} .ttgo-header button:hover{ background:rgba(255,255,255,0.10); }

#${PANEL_ID} .ttgo-body{ padding:10px 10px 10px 12px; overflow:auto; }

#${PANEL_ID} .ttgo-card{
  border:1px solid rgba(255,255,255,0.10);
  border-radius:14px;
  background:rgba(255,255,255,0.04);
  padding:10px;
  margin-bottom:10px;
}

#${PANEL_ID} .ttgo-row{
  display:grid;
  grid-template-columns:1fr auto;
  gap:10px;
  align-items:center;
  padding:3px 0;
}
#${PANEL_ID} .ttgo-label{ opacity:.88; }
#${PANEL_ID} .ttgo-value{
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  opacity:.96;
  white-space:nowrap;
}

#${PANEL_ID} .ttgo-controls{
  display:grid;
  grid-template-columns:1fr 88px;
  gap:8px;
  align-items:center;
}
#${PANEL_ID} input[type="range"]{ width:100%; }
#${PANEL_ID} input[type="number"]{
  width:88px;
  padding:6px 8px;
  border-radius:10px;
  border:1px solid rgba(255,255,255,0.12);
  background:rgba(0,0,0,0.18);
  color:rgba(255,255,255,0.92);
}

#${PANEL_ID} details{
  border:1px solid rgba(255,255,255,0.10);
  border-radius:14px;
  background:rgba(255,255,255,0.03);
  padding:8px 10px;
  margin-bottom:10px;
}
#${PANEL_ID} summary{
  cursor:pointer;
  user-select:none;
  list-style:none;
  display:flex;
  justify-content:space-between;
  gap:10px;
}
#${PANEL_ID} summary::-webkit-details-marker{ display:none; }
#${PANEL_ID} .ttgo-summary-right{
  opacity:.70;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
}

#${PANEL_ID} .ttgo-warn{
  border-left:3px solid rgba(255,199,0,0.85);
  padding:8px 10px;
  border-radius:10px;
  background:rgba(255,199,0,0.08);
  color:rgba(255,255,255,0.90);
  margin-top:8px;
  white-space:pre-wrap;
}
#${PANEL_ID} .ttgo-bad{
  border-left-color:rgba(255,74,74,0.9);
  background:rgba(255,74,74,0.08);
}

#${PANEL_ID} pre{
  margin:8px 0 0 0;
  padding:8px 10px;
  border-radius:12px;
  border:1px solid rgba(255,255,255,0.10);
  background:rgba(0,0,0,0.16);
  overflow:auto;
  white-space:pre-wrap;
  word-break:break-word;
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
  font-size:12px;
}
`;
  if (typeof GM_addStyle === 'function') GM_addStyle(css);
  else {
    const st = document.createElement('style');
    st.textContent = css;
    document.head.appendChild(st);
  }

  /********************************************************************
   * UI (stable DOM — no rebuilding on tick)
   ********************************************************************/
  const ui = {
    panel: null,
    body: null,
    landRange: null,
    landNumber: null,
    statusSummaryRight: null,
    planSummaryRight: null,
    planPre: null,
    warnBox: null,

    // Status fields
    sGame: null,
    sBridge: null,
    sLandTotal: null,
    sLandReserved: null,
    sEcoReserved: null,
    sEcoLandPct: null,
    sEcoReqLand: null,
    sEcoCount: null,
    sEcoActive: null,
    sEcoBuiltInactive: null,
    sTargetLandPct: null,
    sTargetEcoActive: null,
    sNeedBuild: null,
    sNeedActivate: null,
    sColonists: null,
    sColonistsCapNow: null,
    sColonistsCapTarget: null,
    sCapacityFactorNow: null,
    sCapacityFactorTarget: null,
    sGrowthNow: null,
    sEtaColonists: null,
    sAndroids: null,
    sAndroidsCapNow: null,
    sAndroidsCapTarget: null,
    sAndroidNet: null,
    sEtaAndroids: null,
    sWorkers: null,
    sWorkersReq: null,
    sWorkersSlack: null,

    // Debug readiness
    sDbg: null,
  };

  function ensurePanel() {
    if (ui.panel) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    if (state.minimized) panel.classList.add('ttgo-minimized');
    if (state.hidden) panel.classList.add('ttgo-hidden');

    const header = document.createElement('div');
    header.className = 'ttgo-header';

    const titleWrap = document.createElement('div');
    titleWrap.className = 'ttgo-title';
    const title = document.createElement('strong');
    title.textContent = 'TT Growth Optimizer';
    const sub = document.createElement('div');
    sub.className = 'ttgo-sub';
    sub.textContent = 'Land% target → Ecumenopolis → full Colonists + Androids';
    titleWrap.appendChild(title);
    titleWrap.appendChild(sub);

    const btnWrap = document.createElement('div');
    btnWrap.style.display = 'flex';
    btnWrap.style.gap = '8px';

    const minimizeBtn = document.createElement('button');
    minimizeBtn.type = 'button';
    minimizeBtn.textContent = state.minimized ? 'Expand' : 'Minimize';
    minimizeBtn.addEventListener('click', () => {
      state.minimized = !state.minimized;
      saveSetting('minimized', state.minimized);
      minimizeBtn.textContent = state.minimized ? 'Expand' : 'Minimize';
      panel.classList.toggle('ttgo-minimized', state.minimized);
      ui.body.style.display = state.minimized ? 'none' : 'block';
    });

    btnWrap.appendChild(minimizeBtn);

    header.appendChild(titleWrap);
    header.appendChild(btnWrap);

    const body = document.createElement('div');
    body.className = 'ttgo-body';
    if (state.minimized) body.style.display = 'none';

    // Controls
    const controls = document.createElement('div');
    controls.className = 'ttgo-card';

    const controlsHeader = document.createElement('div');
    controlsHeader.style.display = 'flex';
    controlsHeader.style.justifyContent = 'space-between';
    controlsHeader.style.alignItems = 'center';
    controlsHeader.style.marginBottom = '8px';

    const controlsTitle = document.createElement('div');
    controlsTitle.innerHTML = `<span style="opacity:.9"><strong>Goal</strong></span><span style="opacity:.7"> (Land% for ecumenopolis)</span>`;
    controlsHeader.appendChild(controlsTitle);

    const landRange = document.createElement('input');
    landRange.type = 'range';
    landRange.min = '0';
    landRange.max = '100';
    landRange.step = '0.1';
    landRange.value = String(state.landPct);

    const landNumber = document.createElement('input');
    landNumber.type = 'number';
    landNumber.min = '0';
    landNumber.max = '100';
    landNumber.step = '0.1';
    landNumber.value = String(state.landPct);

    const controlsGrid = document.createElement('div');
    controlsGrid.className = 'ttgo-controls';
    controlsGrid.appendChild(landRange);
    controlsGrid.appendChild(landNumber);

    landRange.addEventListener('input', () => setLandPct(Number(landRange.value)));
    landNumber.addEventListener('input', () => setLandPct(Number(landNumber.value)));

    controls.appendChild(controlsHeader);
    controls.appendChild(rowEl('Target Land %', controlsGrid));

    const tip = document.createElement('div');
    tip.className = 'ttgo-warn';
    tip.textContent =
      'Tip: districts can be built ahead of time, but leaving built districts inactive is usually wasted growth.\n' +
      'Active-but-empty districts raise your population cap (K), increasing the logistic growth “capacity factor” (1 − pop/cap).';
    controls.appendChild(tip);

    // Status
    const status = document.createElement('details');
    status.open = state.expandedStatus;
    status.addEventListener('toggle', () => {
      state.expandedStatus = status.open;
      saveSetting('expandedStatus', state.expandedStatus);
    });

    const statusSummary = document.createElement('summary');
    statusSummary.innerHTML = `<span><strong>Status</strong></span>`;
    const statusRight = document.createElement('span');
    statusRight.className = 'ttgo-summary-right';
    statusRight.textContent = '…';
    statusSummary.appendChild(statusRight);
    status.appendChild(statusSummary);

    addStatusRows(status, [
      ['Game', '—', 'sGame'],
      ['Bridge', '—', 'sBridge'],
      ['Debug', '—', 'sDbg'],
      ['Land total', '—', 'sLandTotal'],
      ['Land reserved (all)', '—', 'sLandReserved'],
      ['Eco land reserved', '—', 'sEcoReserved'],
      ['Eco land %', '—', 'sEcoLandPct'],
      ['Eco land per district', '—', 'sEcoReqLand'],
      ['Eco built / active', '—', 'sEcoCount'],
      ['Built but inactive', '—', 'sEcoBuiltInactive'],
      ['Target Land %', '—', 'sTargetLandPct'],
      ['Target eco active', '—', 'sTargetEcoActive'],
      ['Need to build', '—', 'sNeedBuild'],
      ['Need to activate', '—', 'sNeedActivate'],
      ['Colonists', '—', 'sColonists'],
      ['Colonist cap (now)', '—', 'sColonistsCapNow'],
      ['Colonist cap (target)', '—', 'sColonistsCapTarget'],
      ['Capacity factor (now)', '—', 'sCapacityFactorNow'],
      ['Capacity factor (target)', '—', 'sCapacityFactorTarget'],
      ['Growth (now)', '—', 'sGrowthNow'],
      ['ETA colonists (to 99.9%)', '—', 'sEtaColonists'],
      ['Androids', '—', 'sAndroids'],
      ['Android cap (now)', '—', 'sAndroidsCapNow'],
      ['Android cap (target)', '—', 'sAndroidsCapTarget'],
      ['Android net', '—', 'sAndroidNet'],
      ['ETA androids (to 99.9%)', '—', 'sEtaAndroids'],
      ['Workers', '—', 'sWorkers'],
      ['Workers required', '—', 'sWorkersReq'],
      ['Workers slack', '—', 'sWorkersSlack'],
    ]);

    // Plan
    const plan = document.createElement('details');
    plan.open = state.expandedPlan;
    plan.addEventListener('toggle', () => {
      state.expandedPlan = plan.open;
      saveSetting('expandedPlan', state.expandedPlan);
    });

    const planSummary = document.createElement('summary');
    planSummary.innerHTML = `<span><strong>Fastest path plan</strong></span>`;
    const planRight = document.createElement('span');
    planRight.className = 'ttgo-summary-right';
    planRight.textContent = '…';
    planSummary.appendChild(planRight);
    plan.appendChild(planSummary);

    const planPre = document.createElement('pre');
    planPre.textContent = 'Waiting for game state…';
    plan.appendChild(planPre);

    const warn = document.createElement('div');
    warn.className = 'ttgo-warn';
    warn.style.display = 'none';
    plan.appendChild(warn);

    body.appendChild(controls);
    body.appendChild(status);
    body.appendChild(plan);

    panel.appendChild(header);
    panel.appendChild(body);
    document.body.appendChild(panel);

    ui.panel = panel;
    ui.body = body;
    ui.landRange = landRange;
    ui.landNumber = landNumber;
    ui.statusSummaryRight = statusRight;
    ui.planSummaryRight = planRight;
    ui.planPre = planPre;
    ui.warnBox = warn;
  }

  function rowEl(label, valueNodeOrText) {
    const row = document.createElement('div');
    row.className = 'ttgo-row';
    const l = document.createElement('div');
    l.className = 'ttgo-label';
    l.textContent = label;
    const v = document.createElement('div');
    v.className = 'ttgo-value';
    if (typeof valueNodeOrText === 'string') v.textContent = valueNodeOrText;
    else v.appendChild(valueNodeOrText);
    row.appendChild(l);
    row.appendChild(v);
    return row;
  }

  function addStatusRows(detailsEl, rows) {
    for (const [label, initial, key] of rows) {
      const v = document.createElement('span');
      v.textContent = initial;
      detailsEl.appendChild(rowEl(label, v));
      ui[key] = v;
    }
  }

  function setLandPct(val) {
    const next = clampNumber(Number(val), 0, 100);
    state.landPct = next;
    saveSetting('landPct', state.landPct);

    const active = document.activeElement;
    if (ui.landRange && active !== ui.landRange) ui.landRange.value = String(next);
    if (ui.landNumber && active !== ui.landNumber) ui.landNumber.value = String(next);
  }

  /********************************************************************
   * Formatting helpers
   ********************************************************************/
  function clampNumber(x, lo, hi) {
    if (!Number.isFinite(x)) return lo;
    return Math.max(lo, Math.min(hi, x));
  }

  function fmtNumber(n, decimals = 2) {
    if (!Number.isFinite(n)) return '—';
    const { formatNumberFn } = getGameRefs();
    if (formatNumberFn) return formatNumberFn(n, false, clampNumber(decimals, 0, 6));
    const abs = Math.abs(n);
    if (abs >= 1e12) return (n / 1e12).toFixed(decimals) + 'T';
    if (abs >= 1e9) return (n / 1e9).toFixed(decimals) + 'B';
    if (abs >= 1e6) return (n / 1e6).toFixed(decimals) + 'M';
    if (abs >= 1e3) return (n / 1e3).toFixed(decimals) + 'K';
    return n.toFixed(decimals);
  }

  function fmtInt(n) {
    if (!Number.isFinite(n)) return '—';
    return fmtNumber(Math.round(n), 0);
  }

  function fmtPct(n, decimals = 1) {
    if (!Number.isFinite(n)) return '—';
    return `${n.toFixed(decimals)}%`;
  }

  function signedStr(nStrOrNum) {
    const n = Number(nStrOrNum);
    if (!Number.isFinite(n)) return String(nStrOrNum);
    const s = String(nStrOrNum);
    return n >= 0 ? `+${s}` : s;
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds)) return '∞';
    seconds = Math.max(0, seconds);
    if (seconds < 1) return '<1s';
    const s = Math.floor(seconds % 60);
    const m = Math.floor((seconds / 60) % 60);
    const h = Math.floor((seconds / 3600) % 24);
    const d = Math.floor(seconds / 86400);
    const parts = [];
    if (d) parts.push(`${d}d`);
    if (h || d) parts.push(`${h}h`);
    if (m || h || d) parts.push(`${m}m`);
    parts.push(`${s}s`);
    return parts.join(' ');
  }

  function netRate(resObj) {
    if (!resObj) return 0;
    const prod = Number(resObj.productionRate) || 0;
    const cons = Number(resObj.consumptionRate) || 0;
    return prod - cons;
  }

  function availableAmount(resObj) {
    if (!resObj) return 0;
    const v = Number(resObj.value) || 0;
    const r = Number(resObj.reserved) || 0;
    return Math.max(0, v - r);
  }

  function calcCapacityFactor(pop, cap) {
    pop = Number(pop) || 0;
    cap = Number(cap) || 0;
    if (cap <= 0) return 0;
    const ratio = pop / cap;
    if (ratio >= 1) return 0;
    return 1 - ratio;
  }

  /********************************************************************
   * Math (logistic with decay)
   ********************************************************************/
  function etaLogisticToFraction(N0, K, a, d, fraction = 0.999) {
    if (!Number.isFinite(N0) || !Number.isFinite(K) || !Number.isFinite(a) || !Number.isFinite(d)) return { ok: false, reason: 'bad-input' };
    if (K <= 0) return { ok: false, reason: 'no-cap' };
    if (N0 <= 0) return { ok: false, reason: 'no-pop' };
    if (a <= 0) return { ok: false, reason: 'no-growth' };

    const aPrime = a - d;
    if (aPrime <= 0) return { ok: false, reason: 'decay>=growth', a, d };

    const KPrime = K * (aPrime / a);
    if (KPrime <= 0) return { ok: false, reason: 'kprime<=0' };
    if (N0 >= KPrime) return { ok: true, seconds: 0, reachableCap: KPrime, capped: true };

    const target = Math.min(KPrime * clampNumber(fraction, 0.01, 0.9999), KPrime * 0.9999);
    if (target <= N0) return { ok: true, seconds: 0, reachableCap: KPrime, capped: true };

    const num = target * (KPrime - N0);
    const den = N0 * (KPrime - target);
    if (den <= 0 || num <= 0) return { ok: false, reason: 'math' };

    const t = (1 / aPrime) * Math.log(num / den);
    return { ok: true, seconds: t, reachableCap: KPrime, capped: Math.abs(KPrime - K) > 1e-6 };
  }

  function etaLinearToFraction(value, cap, netPerSec, fraction = 0.999) {
    value = Number(value) || 0;
    cap = Number(cap) || 0;
    netPerSec = Number(netPerSec) || 0;
    if (cap <= 0) return { ok: false, reason: 'no cap' };
    const target = cap * clampNumber(fraction, 0.01, 0.9999);
    if (value >= target) return { ok: true, seconds: 0 };
    if (netPerSec <= 0) return { ok: false, reason: 'net ≤ 0' };
    return { ok: true, seconds: (target - value) / netPerSec };
  }

  /********************************************************************
   * Build ETA (resource-gated)
   ********************************************************************/
  function estimateBuildEtaSeconds(structure, buildCount) {
    buildCount = Math.max(0, Math.floor(Number(buildCount) || 0));
    if (!structure || buildCount <= 0) return 0;

    const { resources } = getGameRefs();
    if (!resources) return Infinity;

    let cost;
    try {
      cost = structure.getEffectiveCost(buildCount);
    } catch (_) {
      cost = structure.getEffectiveCost ? structure.getEffectiveCost(1) : null;
      if (!cost) return Infinity;

      const scaled = {};
      for (const cat in cost) {
        scaled[cat] = {};
        for (const res in cost[cat]) scaled[cat][res] = (Number(cost[cat][res]) || 0) * buildCount;
      }
      cost = scaled;
    }

    let worst = 0;

    for (const category in cost) {
      for (const resKey in cost[category]) {
        const need = Number(cost[category][resKey]) || 0;
        if (need <= 0) continue;

        const resObj = resources?.[category]?.[resKey];
        if (!resObj) continue;

        const have = availableAmount(resObj);
        const missing = Math.max(0, need - have);
        if (missing <= 0) continue;

        const r = netRate(resObj);
        if (r <= 0) return Infinity;

        const t = missing / r;
        if (t > worst) worst = t;
      }
    }

    return worst;
  }

  function etaToAffordResearch(research) {
    const { resources } = getGameRefs();
    if (!resources || !research || !research.cost) return '—';
    if (research.isResearched) return 'done';

    const entries = Object.entries(research.cost || {});
    if (!entries.length) return '—';

    const [costKey, costVal] = entries[0];
    const resObj = resources.colony?.[costKey];
    if (!resObj) return '—';

    const cost = Number(costVal) || 0;
    const have = Number(resObj.value) || 0;
    if (have >= cost) return 'ready';

    const r = netRate(resObj);
    if (r <= 0) return 'blocked (net ≤ 0)';
    return formatDuration((cost - have) / r);
  }

  function reasonToHuman(reason, extra) {
    if (reason === 'no-pop') return 'No colonists yet';
    if (reason === 'no-cap') return 'No housing cap';
    if (reason === 'no-growth') return 'Growth = 0 (happiness ≤ 50%)';
    if (reason === 'decay>=growth') return `Decay ≥ growth (a=${fmtNumber(extra?.a ?? 0, 6)}, d=${fmtNumber(extra?.d ?? 0, 6)})`;
    return `— (${reason})`;
  }

  /********************************************************************
   * Main update loop
   ********************************************************************/
  function update() {
    injectBridge(); // harmless repeat; ensures bridge survives reload quirks
    ensurePanel();

    const { resources, colonies, populationModule, researchManager, bridgeOk } = getGameRefs();

    const hasRes = !!(resources && resources.colony && resources.surface);
    const hasCol = !!colonies;
    const hasPop = !!populationModule;

    ui.sBridge.textContent = bridgeOk ? 'OK' : 'injecting…';
    ui.sDbg.textContent = `resources:${hasRes ? 'Y' : 'N'} colonies:${hasCol ? 'Y' : 'N'} pop:${hasPop ? 'Y' : 'N'}`;

    if (!hasRes || !hasCol || !hasPop) {
      ui.sGame.textContent = 'Waiting for TT globals…';
      ui.statusSummaryRight.textContent = 'Not ready';
      ui.planSummaryRight.textContent = 'Not ready';
      ui.planPre.textContent =
        'Waiting for game state…\n\n' +
        'If this stays stuck:\n' +
        '• Hard refresh (Ctrl+F5)\n' +
        '• Ensure the script is running inside the game iframe URL (hwcdn/itch html/*/index.html)\n' +
        '• Open DevTools console and run: window.__TTGO_BRIDGE_OK__ (should be true)';
      ui.warnBox.style.display = 'none';
      return;
    }

    ui.sGame.textContent = 'OK';

    const land = resources.surface.land;
    const totalLand = Number(land.value) || 0;
    const reservedLand = Number(land.reserved) || 0;

    ui.sLandTotal.textContent = fmtNumber(totalLand, 2);
    ui.sLandReserved.textContent = `${fmtNumber(reservedLand, 2)} (${fmtPct(totalLand > 0 ? (reservedLand / totalLand) * 100 : 0, 2)})`;

    const eco = colonies.t7_colony;
    if (!eco) {
      ui.sEcoReserved.textContent = '—';
      ui.sEcoLandPct.textContent = '—';
      ui.sEcoReqLand.textContent = '—';
      ui.sEcoCount.textContent = '—';
      ui.sEcoActive.textContent = '—';
      ui.sEcoBuiltInactive.textContent = '—';

      ui.sTargetLandPct.textContent = fmtPct(state.landPct, 1);
      ui.sTargetEcoActive.textContent = '—';
      ui.sNeedBuild.textContent = '—';
      ui.sNeedActivate.textContent = '—';

      ui.planPre.textContent =
        'Ecumenopolis (t7_colony) not detected.\n\n' +
        'Next steps (likely):\n' +
        '• Unlock Superalloys\n' +
        '• Research Ecumenopolis District (t7_colony)\n\n' +
        'Once t7 exists, this overlay computes targets + ETAs.';
      ui.statusSummaryRight.textContent = 't7 missing';
      ui.planSummaryRight.textContent = 'research → t7';
      ui.warnBox.style.display = 'none';
      return;
    }

    const ecoActive = Number(eco.active) || 0;
    const ecoCount = Number(eco.count) || 0;
    const ecoReqLand = Number(eco.requiresLand) || 0;

    const ecoReserved = land.getReservedAmountForSource
      ? (Number(land.getReservedAmountForSource('building:t7_colony')) || 0)
      : ecoActive * ecoReqLand;

    const ecoLandPct = totalLand > 0 ? (ecoReserved / totalLand) * 100 : 0;

    ui.sEcoReserved.textContent = fmtNumber(ecoReserved, 2);
    ui.sEcoLandPct.textContent = fmtPct(ecoLandPct, 3);
    ui.sEcoReqLand.textContent = ecoReqLand > 0 ? fmtNumber(ecoReqLand, 0) : '—';
    ui.sEcoCount.textContent = `${fmtInt(ecoCount)}`;
    ui.sEcoActive.textContent = `${fmtInt(ecoActive)}`;
    ui.sEcoBuiltInactive.textContent = fmtInt(Math.max(0, ecoCount - ecoActive));

    // Target Land% → target active eco districts
    const targetLandPct = state.landPct;
    const targetEcoReserved = totalLand * (targetLandPct / 100);
    const targetEcoActive = ecoReqLand > 0 ? Math.ceil(targetEcoReserved / ecoReqLand) : 0;

    ui.sTargetLandPct.textContent = fmtPct(targetLandPct, 1);
    ui.sTargetEcoActive.textContent = fmtInt(targetEcoActive);

    const needBuild = Math.max(0, targetEcoActive - ecoCount);
    const needActivate = Math.max(0, targetEcoActive - ecoActive);

    ui.sNeedBuild.textContent = fmtInt(needBuild);
    ui.sNeedActivate.textContent = fmtInt(needActivate);

    // Caps now vs target (approx)
    const colonists = resources.colony.colonists;
    const androids = resources.colony.androids;

    const storageMult = typeof eco.getEffectiveStorageMultiplier === 'function'
      ? (eco.getEffectiveStorageMultiplier() || 1)
      : 1;

    const ecoColPer = (eco.storage?.colony?.colonists ?? 0) * storageMult;
    const ecoAndPer = (eco.storage?.colony?.androids ?? 0) * storageMult;

    const colonistsCapNow = Number(colonists.cap) || 0;
    const androidsCapNow = Number(androids.cap) || 0;

    const otherColonistCap = Math.max(0, colonistsCapNow - ecoActive * ecoColPer);
    const otherAndroidCap = Math.max(0, androidsCapNow - ecoActive * ecoAndPer);

    const colonistsCapTarget = otherColonistCap + targetEcoActive * ecoColPer;
    const androidsCapTarget = otherAndroidCap + targetEcoActive * ecoAndPer;

    ui.sColonists.textContent = `${fmtNumber(colonists.value, 2)} / ${fmtNumber(colonistsCapNow, 2)}`;
    ui.sColonistsCapNow.textContent = fmtNumber(colonistsCapNow, 2);
    ui.sColonistsCapTarget.textContent = fmtNumber(colonistsCapTarget, 2);

    ui.sAndroids.textContent = `${fmtNumber(androids.value, 2)} / ${fmtNumber(androidsCapNow, 2)}`;
    ui.sAndroidsCapNow.textContent = fmtNumber(androidsCapNow, 2);
    ui.sAndroidsCapTarget.textContent = fmtNumber(androidsCapTarget, 2);

    const capFactorNow = calcCapacityFactor(colonists.value, colonistsCapNow);
    const capFactorTarget = calcCapacityFactor(colonists.value, colonistsCapTarget);
    ui.sCapacityFactorNow.textContent = fmtPct(capFactorNow * 100, 2);
    ui.sCapacityFactorTarget.textContent = fmtPct(capFactorTarget * 100, 2);

    const growthPctNow = (typeof populationModule.getCurrentGrowthPercent === 'function')
      ? (populationModule.getCurrentGrowthPercent() || 0)
      : 0;
    ui.sGrowthNow.textContent = `${signedStr(fmtNumber(growthPctNow, 3))}%/s`;

    // Build ETA, then fill ETA (colonists logistic, androids linear)
    const buildEta = estimateBuildEtaSeconds(eco, needBuild);
    const buildEtaStr = Number.isFinite(buildEta) ? formatDuration(buildEta) : '∞';

    const popNetNow = Number(populationModule.getCurrentGrowthPerSecond?.() ?? populationModule.lastGrowthPerSecond ?? 0) || 0;
    const N0 = Number(colonists.value) || 0;
    const N1 = Math.max(0, N0 + Math.max(0, popNetNow) * (Number.isFinite(buildEta) ? buildEta : 0));

    const A0 = Number(androids.value) || 0;
    const aNet = netRate(androids);
    const A1 = Math.max(0, A0 + Math.max(0, aNet) * (Number.isFinite(buildEta) ? buildEta : 0));

    const baseR = Number(populationModule.growthRate) || 0;
    const multM = (typeof populationModule.getEffectiveGrowthMultiplier === 'function')
      ? (Number(populationModule.getEffectiveGrowthMultiplier()) || 1)
      : 1;
    const decayD =
      (Number(populationModule.starvationDecayRate) || 0) +
      (Number(populationModule.energyDecayRate) || 0) +
      (Number(populationModule.gravityDecayRate) || 0);

    const a = baseR * multM;

    const etaCol = etaLogisticToFraction(Math.max(1, N1), colonistsCapTarget, a, decayD, 0.999);
    const etaColonistsStr = etaCol.ok ? formatDuration(etaCol.seconds) : reasonToHuman(etaCol.reason, etaCol);

    ui.sEtaColonists.textContent = etaColonistsStr;

    const etaAnd = etaLinearToFraction(A1, androidsCapTarget, aNet, 0.999);
    ui.sAndroidNet.textContent = `${signedStr(fmtNumber(aNet, 3))}/s`;
    ui.sEtaAndroids.textContent = etaAnd.ok ? formatDuration(etaAnd.seconds) : etaAnd.reason;

    // Workers
    const workers = resources.colony.workers;
    const workersCap = Number(workers.cap) || 0;
    const workersReq = Number(populationModule.totalWorkersRequired) || 0;
    const slack = workersCap - workersReq;

    ui.sWorkers.textContent = `${fmtNumber(workers.value, 2)} / ${fmtNumber(workersCap, 2)}`;
    ui.sWorkersReq.textContent = fmtNumber(workersReq, 2);
    ui.sWorkersSlack.textContent = `${slack >= 0 ? '+' : ''}${fmtNumber(slack, 2)}`;

    ui.statusSummaryRight.textContent =
      `${fmtPct(ecoLandPct, 2)} → ${fmtPct(targetLandPct, 1)} | capFactor ×${(capFactorTarget / Math.max(1e-9, capFactorNow)).toFixed(2)}`;

    // Plan text
    const planLines = [];
    planLines.push(`Target: ${fmtPct(targetLandPct, 1)} land in Ecumenopolis → target active districts: ${fmtInt(targetEcoActive)}`);
    planLines.push('');

    if (researchManager && typeof researchManager.getResearchById === 'function') {
      const rSuper = researchManager.getResearchById('super_alloys');
      const rEco = researchManager.getResearchById('t7_colony');

      const hasFlag = typeof researchManager.isBooleanFlagSet === 'function'
        ? researchManager.isBooleanFlagSet('superalloyResearchUnlocked')
        : false;

      if (!hasFlag && rSuper) planLines.push(`1) Unlock Superalloys. ETA to afford: ${etaToAffordResearch(rSuper)}`);
      else planLines.push(`1) Superalloys unlock flag: OK`);

      if (rEco && !rEco.isResearched) planLines.push(`2) Research Ecumenopolis District (t7_colony). ETA to afford: ${etaToAffordResearch(rEco)}`);
      else planLines.push(`2) Ecumenopolis research: OK`);
    } else {
      planLines.push(`(Research status unavailable)`);
    }

    planLines.push('');
    planLines.push(`3) Build districts until count ≥ target active.`);
    planLines.push(`   • Need to build: ${fmtInt(needBuild)} | Est. build ETA: ${buildEtaStr}`);
    planLines.push(`4) Activate districts up to target active (active-but-empty is optimal for growth).`);
    planLines.push(`   • Need to activate: ${fmtInt(needActivate)}`);
    planLines.push('');
    planLines.push(`5) Fill population (99.9%):`);
    planLines.push(`   • Colonists ETA (after build): ${etaColonistsStr}`);
    planLines.push(`   • Androids ETA (after build): ${ui.sEtaAndroids.textContent}`);
    planLines.push('');
    planLines.push(`Capacity factor now: ${fmtPct(capFactorNow * 100, 2)} → target: ${fmtPct(capFactorTarget * 100, 2)}`);

    ui.planPre.textContent = planLines.join('\n');
    ui.planSummaryRight.textContent = `build ${buildEtaStr} | fill ${etaColonistsStr}`;

    // Warnings
    const warnings = [];
    const starvation = Number(populationModule.starvationShortage) || 0;
    const energyShort = Number(populationModule.energyShortage) || 0;

    if (a <= 0) warnings.push('Colonist base growth is 0 (happiness ≤ 50%). Improve needs/comfort/milestones.');
    if (decayD > 0 && decayD >= a) warnings.push('Decay ≥ growth: you are cap-limited by starvation/energy/gravity decay.');
    if (starvation > 0.001) warnings.push(`Starvation active: ${(starvation * 100).toFixed(1)}% starving.`);
    if (energyShort > 0.001) warnings.push(`Power shortage: ${(energyShort * 100).toFixed(1)}% without energy.`);

    const builtInactive = Math.max(0, ecoCount - ecoActive);
    if (builtInactive > 0 && ecoLandPct < targetLandPct - 1e-6) {
      warnings.push(`You have ${fmtInt(builtInactive)} built but inactive eco districts — activating them usually speeds growth (unless land-locked).`);
    }

    if (warnings.length) {
      ui.warnBox.style.display = 'block';
      ui.warnBox.classList.toggle('ttgo-bad', warnings.some(w => /Starvation|shortage|Decay|growth is 0/i.test(w)));
      ui.warnBox.textContent = '• ' + warnings.join('\n• ');
    } else {
      ui.warnBox.style.display = 'none';
    }
  }

  /********************************************************************
   * Hotkey: Alt+G toggle visibility
   ********************************************************************/
  window.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.code !== 'KeyG') return;
    state.hidden = !state.hidden;
    saveSetting('hidden', state.hidden);
    if (ui.panel) ui.panel.classList.toggle('ttgo-hidden', state.hidden);
  }, true);

  /********************************************************************
   * Boot
   ********************************************************************/
  ensurePanel();
  update();
  setInterval(update, UPDATE_MS);

})();
