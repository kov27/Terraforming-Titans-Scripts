// ==UserScript==
// @name         Terraforming Titans Growth Optimizer (Docked Right UI) [0.1.5]
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.1.5
// @description  Docked-right overlay that estimates the fastest route to a Land%-sized ecumenopolis and full Colonist+Android occupancy. Includes page-bridge so it can read TT globals.
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

    def('colonies', () => (typeof colonies !== 'undefined' ? colonies : undefined), (v) => { try { colonies = v; } catch (e) {} });
    def('populationModule', () => (typeof populationModule !== 'undefined' ? populationModule : undefined), (v) => { try { populationModule = v; } catch (e) {} });
    def('researchManager', () => (typeof researchManager !== 'undefined' ? researchManager : undefined), (v) => { try { researchManager = v; } catch (e) {} });
    def('terraforming', () => (typeof terraforming !== 'undefined' ? terraforming : undefined), (v) => { try { terraforming = v; } catch (e) {} });
    def('structures', () => (typeof structures !== 'undefined' ? structures : undefined), (v) => { try { structures = v; } catch (e) {} });

    def('resources', () => (typeof resources !== 'undefined' ? resources : undefined), (v) => { try { resources = v; } catch (e) {} });
    def('buildings', () => (typeof buildings !== 'undefined' ? buildings : undefined), (v) => { try { buildings = v; } catch (e) {} });
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
   * Storage helpers
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
   * Globals access
   ********************************************************************/
  const W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  function getGameRefs() {
    return {
      resources: W.resources,
      colonies: W.colonies,
      populationModule: W.populationModule,
      researchManager: W.researchManager,
      formatNumberFn: typeof W.formatNumber === 'function' ? W.formatNumber : null,
      bridgeOk: !!W.__TTGO_BRIDGE_OK__,
    };
  }

  /********************************************************************
   * Config / State
   ********************************************************************/
  const PANEL_ID = 'ttgo-panel';
  const UPDATE_MS = 1000;

  const DOCK_WIDTH_EXPANDED = 420;
  const DOCK_WIDTH_MINIMIZED = 240;

  const state = {
    landPct: clampNumber(Number(loadSetting('landPct', 30)), 0, 100),
    expandedStatus: Boolean(loadSetting('expandedStatus', true)),
    expandedPlan: Boolean(loadSetting('expandedPlan', true)),
    minimized: Boolean(loadSetting('minimized', false)),
    hidden: Boolean(loadSetting('hidden', false)),
  };

  /********************************************************************
   * Docking (push game left so panel never blocks clicks)
   ********************************************************************/
  function setDockPad(px) {
    const root = document.documentElement;
    if (px > 0) {
      root.classList.add('ttgo-docked');
      root.style.setProperty('--ttgo-dock-pad', `${px}px`);
    } else {
      root.classList.remove('ttgo-docked');
      root.style.setProperty('--ttgo-dock-pad', `0px`);
    }
  }

  function applyDockingNow() {
    if (state.hidden) return setDockPad(0);
    setDockPad(state.minimized ? DOCK_WIDTH_MINIMIZED : DOCK_WIDTH_EXPANDED);
  }

  /********************************************************************
   * CSS
   ********************************************************************/
  const css = `
:root{ --ttgo-dock-pad: 0px; }

/* Reserve space for the docked panel */
html.ttgo-docked body{
  padding-right: var(--ttgo-dock-pad) !important;
  box-sizing: border-box;
}

#${PANEL_ID}{
  position: fixed;
  top: 8px;
  right: 8px;
  bottom: 8px;
  width: ${DOCK_WIDTH_EXPANDED}px;
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

/* Hidden just removes the panel; docking pad also removed in JS */
#${PANEL_ID}.ttgo-hidden{ display:none; }

/* Minimized: shrink width and collapse body so it doesn't block much even if undocked */
#${PANEL_ID}.ttgo-minimized{
  width: ${DOCK_WIDTH_MINIMIZED}px;
  bottom: auto;
}
#${PANEL_ID}.ttgo-minimized .ttgo-body{ display:none; }

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
   * UI
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

    sGame: null,
    sBridge: null,
    sDbg: null,
    sErr: null,

    sLandTotal: null,
    sLandReserved: null,

    sEcoReserved: null,
    sEcoLandPct: null,
    sEcoReqLand: null,
    sEcoBuilt: null,
    sEcoActive: null,
    sEcoBuiltInactive: null,

    sTargetLandPct: null,
    sTargetEcoActive: null,
    sTargetAchievedPct: null,
    sNextStepPct: null,

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
  };

  function ensurePanel() {
    if (ui.panel) return;

    const panel = document.createElement('div');
    panel.id = PANEL_ID;
    if (state.hidden) panel.classList.add('ttgo-hidden');
    if (state.minimized) panel.classList.add('ttgo-minimized');

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
      applyDockingNow();
    });

    btnWrap.appendChild(minimizeBtn);

    header.appendChild(titleWrap);
    header.appendChild(btnWrap);

    const body = document.createElement('div');
    body.className = 'ttgo-body';

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
      ['Last error', '—', 'sErr'],

      ['Land total', '—', 'sLandTotal'],
      ['Land reserved (all)', '—', 'sLandReserved'],

      ['Eco land reserved', '—', 'sEcoReserved'],
      ['Eco land %', '—', 'sEcoLandPct'],
      ['Eco land per district', '—', 'sEcoReqLand'],
      ['Eco built', '—', 'sEcoBuilt'],
      ['Eco active', '—', 'sEcoActive'],
      ['Built but inactive', '—', 'sEcoBuiltInactive'],

      ['Target Land %', '—', 'sTargetLandPct'],
      ['Target eco active', '—', 'sTargetEcoActive'],
      ['Achieved eco land %', '—', 'sTargetAchievedPct'],
      ['+1 district would be', '—', 'sNextStepPct'],

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

    // Apply docking after DOM is present
    applyDockingNow();
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

  function setText(el, text) {
    if (!el) return;
    el.textContent = text;
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
   * Helpers / formatting
   ********************************************************************/
  const countFmt = new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 });

  function fmtCount(n) {
    if (!Number.isFinite(n)) return '—';
    return countFmt.format(Math.round(n));
  }

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

  function etaLogisticToFraction(N0, K, a, d, fraction = 0.999) {
    if (!Number.isFinite(N0) || !Number.isFinite(K) || !Number.isFinite(a) || !Number.isFinite(d)) return { ok: false, reason: 'bad-input' };
    if (K <= 0) return { ok: false, reason: 'no-cap' };
    if (N0 <= 0) return { ok: false, reason: 'no-pop' };
    if (a <= 0) return { ok: false, reason: 'no-growth' };

    const aPrime = a - d;
    if (aPrime <= 0) return { ok: false, reason: 'decay>=growth', a, d };

    const KPrime = K * (aPrime / a);
    if (KPrime <= 0) return { ok: false, reason: 'kprime<=0' };
    if (N0 >= KPrime) return { ok: true, seconds: 0 };

    const target = Math.min(KPrime * clampNumber(fraction, 0.01, 0.9999), KPrime * 0.9999);
    if (target <= N0) return { ok: true, seconds: 0 };

    const num = target * (KPrime - N0);
    const den = N0 * (KPrime - target);
    if (den <= 0 || num <= 0) return { ok: false, reason: 'math' };

    const t = (1 / aPrime) * Math.log(num / den);
    return { ok: true, seconds: t };
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

  function reasonToHuman(reason, extra) {
    if (reason === 'no-pop') return 'No colonists yet';
    if (reason === 'no-cap') return 'No housing cap';
    if (reason === 'no-growth') return 'Growth = 0 (happiness ≤ 50%)';
    if (reason === 'decay>=growth') return `Decay ≥ growth (a=${fmtNumber(extra?.a ?? 0, 6)}, d=${fmtNumber(extra?.d ?? 0, 6)})`;
    return `— (${reason})`;
  }

  function getScaledCost(structure, buildCount) {
    buildCount = Math.max(0, Math.floor(Number(buildCount) || 0));
    if (!structure || buildCount <= 0) return null;

    try {
      return structure.getEffectiveCost(buildCount);
    } catch (_) {
      const base = structure.getEffectiveCost ? structure.getEffectiveCost(1) : null;
      if (!base) return null;
      const scaled = {};
      for (const cat in base) {
        scaled[cat] = {};
        for (const res in base[cat]) scaled[cat][res] = (Number(base[cat][res]) || 0) * buildCount;
      }
      return scaled;
    }
  }

  function estimateBuildEtaSeconds(structure, buildCount) {
    buildCount = Math.max(0, Math.floor(Number(buildCount) || 0));
    if (!structure || buildCount <= 0) return 0;

    const { resources } = getGameRefs();
    const cost = getScaledCost(structure, buildCount);
    if (!resources || !cost) return Infinity;

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

        worst = Math.max(worst, missing / r);
      }
    }

    return worst;
  }

  /********************************************************************
   * Main update loop
   ********************************************************************/
  function update() {
    try {
      injectBridge();
      ensurePanel();
      applyDockingNow();

      const { resources, colonies, populationModule, bridgeOk } = getGameRefs();

      const hasRes = !!(resources && resources.colony && resources.surface);
      const hasCol = !!colonies;
      const hasPop = !!populationModule;

      setText(ui.sBridge, bridgeOk ? 'OK' : 'injecting…');
      setText(ui.sDbg, `resources:${hasRes ? 'Y' : 'N'} colonies:${hasCol ? 'Y' : 'N'} pop:${hasPop ? 'Y' : 'N'}`);
      setText(ui.sErr, '—');

      if (!hasRes || !hasCol || !hasPop) {
        setText(ui.sGame, 'Waiting for TT globals…');
        ui.statusSummaryRight.textContent = 'Not ready';
        ui.planSummaryRight.textContent = 'Not ready';
        ui.planPre.textContent = 'Waiting for game state…';
        ui.warnBox.style.display = 'none';
        return;
      }

      setText(ui.sGame, 'OK');

      const land = resources.surface.land;
      const totalLand = Number(land.value) || 0;
      const reservedLand = Number(land.reserved) || 0;

      setText(ui.sLandTotal, fmtNumber(totalLand, 2));
      setText(ui.sLandReserved, `${fmtNumber(reservedLand, 2)} (${fmtPct(totalLand > 0 ? (reservedLand / totalLand) * 100 : 0, 2)})`);

      const eco = colonies.t7_colony;
      if (!eco) {
        ui.planPre.textContent = 'Ecumenopolis (t7_colony) not detected.';
        ui.planSummaryRight.textContent = 't7 missing';
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

      setText(ui.sEcoReserved, fmtNumber(ecoReserved, 2));
      setText(ui.sEcoLandPct, fmtPct(ecoLandPct, 3));
      setText(ui.sEcoReqLand, ecoReqLand > 0 ? fmtNumber(ecoReqLand, 0) : '—');
      setText(ui.sEcoBuilt, fmtCount(ecoCount));
      setText(ui.sEcoActive, fmtCount(ecoActive));
      setText(ui.sEcoBuiltInactive, fmtCount(Math.max(0, ecoCount - ecoActive)));

      // Land% target → districts (FLOOR + CLAMP)
      const targetLandPct = state.landPct;
      setText(ui.sTargetLandPct, fmtPct(targetLandPct, 1));

      const maxEcoByLand = (ecoReqLand > 0 && totalLand > 0) ? Math.floor(totalLand / ecoReqLand) : 0;
      const desiredReserved = totalLand * (targetLandPct / 100);

      let targetEcoActive = (ecoReqLand > 0) ? Math.floor((desiredReserved / ecoReqLand) + 1e-9) : 0;
      if (maxEcoByLand > 0) targetEcoActive = Math.min(targetEcoActive, maxEcoByLand);
      targetEcoActive = Math.max(0, targetEcoActive);

      const achievedReserved = targetEcoActive * ecoReqLand;
      const achievedPct = totalLand > 0 ? (achievedReserved / totalLand) * 100 : 0;

      const nextEco = Math.min(targetEcoActive + 1, maxEcoByLand);
      const nextPct = (nextEco !== targetEcoActive && totalLand > 0)
        ? ((nextEco * ecoReqLand) / totalLand) * 100
        : NaN;

      setText(ui.sTargetEcoActive, fmtCount(targetEcoActive));
      setText(ui.sTargetAchievedPct, fmtPct(achievedPct, 3));
      setText(ui.sNextStepPct, Number.isFinite(nextPct) ? fmtPct(nextPct, 3) : '— (max)');

      const needBuild = Math.max(0, targetEcoActive - ecoCount);
      const needActivate = Math.max(0, targetEcoActive - ecoActive);
      setText(ui.sNeedBuild, fmtCount(needBuild));
      setText(ui.sNeedActivate, fmtCount(needActivate));

      // Caps now vs target
      const colonists = resources.colony.colonists;
      const androids = resources.colony.androids;

      const colonistsCapNow = Number(colonists?.cap) || 0;
      const androidsCapNow = Number(androids?.cap) || 0;

      setText(ui.sColonists, colonists ? `${fmtNumber(colonists.value, 2)} / ${fmtNumber(colonists.cap, 2)}` : '—');
      setText(ui.sAndroids, androids ? `${fmtNumber(androids.value, 2)} / ${fmtNumber(androids.cap, 2)}` : '—');
      setText(ui.sColonistsCapNow, fmtNumber(colonistsCapNow, 2));
      setText(ui.sAndroidsCapNow, fmtNumber(androidsCapNow, 2));

      const storageMult = typeof eco.getEffectiveStorageMultiplier === 'function'
        ? (eco.getEffectiveStorageMultiplier() || 1)
        : 1;

      const ecoColPer = (eco.storage?.colony?.colonists ?? 0) * storageMult;
      const ecoAndPer = (eco.storage?.colony?.androids ?? 0) * storageMult;

      const otherColonistCap = Math.max(0, colonistsCapNow - ecoActive * ecoColPer);
      const otherAndroidCap = Math.max(0, androidsCapNow - ecoActive * ecoAndPer);

      const colonistsCapTarget = otherColonistCap + targetEcoActive * ecoColPer;
      const androidsCapTarget = otherAndroidCap + targetEcoActive * ecoAndPer;

      setText(ui.sColonistsCapTarget, fmtNumber(colonistsCapTarget, 2));
      setText(ui.sAndroidsCapTarget, fmtNumber(androidsCapTarget, 2));

      const capFactorNow = calcCapacityFactor(colonists?.value, colonistsCapNow);
      const capFactorTarget = calcCapacityFactor(colonists?.value, colonistsCapTarget);
      setText(ui.sCapacityFactorNow, fmtPct(capFactorNow * 100, 2));
      setText(ui.sCapacityFactorTarget, fmtPct(capFactorTarget * 100, 2));

      const growthPctNow = (typeof populationModule.getCurrentGrowthPercent === 'function')
        ? (populationModule.getCurrentGrowthPercent() || 0)
        : 0;
      setText(ui.sGrowthNow, `${signedStr(fmtNumber(growthPctNow, 3))}%/s`);

      const buildEta = estimateBuildEtaSeconds(eco, needBuild);
      const buildEtaStr = (needBuild <= 0) ? '0s' : (Number.isFinite(buildEta) ? formatDuration(buildEta) : '∞');

      const popNetNow = Number(populationModule.getCurrentGrowthPerSecond?.() ?? populationModule.lastGrowthPerSecond ?? 0) || 0;
      const N0 = Number(colonists?.value) || 0;
      const N1 = Math.max(0, N0 + Math.max(0, popNetNow) * (Number.isFinite(buildEta) ? buildEta : 0));

      const A0 = Number(androids?.value) || 0;
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
      setText(ui.sEtaColonists, etaColonistsStr);

      const etaAnd = etaLinearToFraction(A1, androidsCapTarget, aNet, 0.999);
      setText(ui.sAndroidNet, `${signedStr(fmtNumber(aNet, 3))}/s`);
      setText(ui.sEtaAndroids, etaAnd.ok ? formatDuration(etaAnd.seconds) : etaAnd.reason);

      // Workers
      const workers = resources.colony.workers;
      const workersCap = Number(workers?.cap) || 0;
      const workersReq = Number(populationModule.totalWorkersRequired) || 0;
      const slack = workersCap - workersReq;

      setText(ui.sWorkers, workers ? `${fmtNumber(workers.value, 2)} / ${fmtNumber(workers.cap, 2)}` : '—');
      setText(ui.sWorkersReq, fmtNumber(workersReq, 2));
      setText(ui.sWorkersSlack, `${slack >= 0 ? '+' : ''}${fmtNumber(slack, 2)}`);

      ui.statusSummaryRight.textContent =
        `${fmtPct(ecoLandPct, 2)} → ${fmtPct(targetLandPct, 1)} | capFactor ${fmtPct(capFactorNow * 100, 2)}→${fmtPct(capFactorTarget * 100, 2)}`;

      const planLines = [];
      planLines.push(`Target: ${fmtPct(targetLandPct, 1)} land in Ecumenopolis`);
      planLines.push(`• Discrete target districts: ${fmtCount(targetEcoActive)} (achieves ${fmtPct(achievedPct, 3)})`);
      planLines.push(Number.isFinite(nextPct) ? `• Next district would be: ${fmtPct(nextPct, 3)}` : `• Next district: — (already at max by land)`);
      planLines.push('');
      planLines.push(`Build: need +${fmtCount(needBuild)} | Activate: need +${fmtCount(needActivate)}`);
      planLines.push(`Est. build gating ETA (slowest resource): ${buildEtaStr}`);
      planLines.push('');
      planLines.push(`Fill (99.9%): Colonists ${etaColonistsStr} | Androids ${etaAnd.ok ? formatDuration(etaAnd.seconds) : etaAnd.reason}`);
      planLines.push('');
      planLines.push(`Active-but-empty districts are optimal for growth: they raise K (cap), boosting (1 − pop/cap).`);
      planLines.push(`Capacity factor now ${fmtPct(capFactorNow * 100, 2)} → target ${fmtPct(capFactorTarget * 100, 2)}`);

      ui.planPre.textContent = planLines.join('\n');
      ui.planSummaryRight.textContent = `build ${buildEtaStr} | fill ${etaColonistsStr}`;

      // Warnings
      const warnings = [];
      const starvation = Number(populationModule.starvationShortage) || 0;
      const energyShort = Number(populationModule.energyShortage) || 0;
      const workersVal = Number(workers?.value) || 0;

      if (a <= 0) warnings.push('Colonist base growth is 0 (happiness ≤ 50%). Improve needs/comfort/milestones.');
      if (decayD > 0 && decayD >= a) warnings.push('Decay ≥ growth: cap-limited by starvation/energy/gravity decay.');
      if (starvation > 0.001) warnings.push(`Starvation active: ${(starvation * 100).toFixed(1)}% starving.`);
      if (energyShort > 0.001) warnings.push(`Power shortage: ${(energyShort * 100).toFixed(1)}% without energy.`);
      if (workersVal < 0 || slack < 0) warnings.push(`Worker shortage: available workers ${fmtNumber(workersVal, 2)}, slack ${fmtNumber(slack, 2)}.`);

      if (warnings.length) {
        ui.warnBox.style.display = 'block';
        ui.warnBox.classList.toggle('ttgo-bad', true);
        ui.warnBox.textContent = '• ' + warnings.join('\n• ');
      } else {
        ui.warnBox.style.display = 'none';
      }
    } catch (e) {
      try {
        setText(ui.sErr, (e && (e.message || String(e))) ? (e.message || String(e)) : 'Unknown error');
        ui.planPre.textContent = 'Update crashed. Copy “Last error” from Status.';
      } catch (_) {}
    }
  }

  /********************************************************************
   * Hotkey: Alt+G toggle visibility (and docking)
   ********************************************************************/
  window.addEventListener('keydown', (e) => {
    if (!e.altKey) return;
    if (e.code !== 'KeyG') return;

    state.hidden = !state.hidden;
    saveSetting('hidden', state.hidden);

    if (ui.panel) ui.panel.classList.toggle('ttgo-hidden', state.hidden);
    applyDockingNow();
  }, true);

  /********************************************************************
   * Boot
   ********************************************************************/
  ensurePanel();
  applyDockingNow();
  update();
  setInterval(update, UPDATE_MS);

})();
