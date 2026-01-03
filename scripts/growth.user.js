// ==UserScript==
// @name         Terraforming Titans Growth Optimizer (Actionable Eco Plan) [Docked Right]
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.3.0
// @description  Docked overlay that outputs concrete next actions (build/activate/toggle) to reach a fully-built, fully-populated Ecumenopolis (Colonists + Androids).
// @author       kov27
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @grant        none
// ==/UserScript==

(function () {
  'use strict';

  const APP = {
    key: 'TTGO',
    version: '0.3.0',
    bridgeKey: '__TTGO_BRIDGE__',
    uiId: 'ttgo-root',
    storageKey: 'TTGO_SETTINGS_V1',
  };

  // ---------- Utilities ----------
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const now = () => Date.now();

  function safeNum(n, d = 0) {
    return Number.isFinite(n) ? n : d;
  }

  function fmt(n, digits = 2) {
    n = safeNum(n, 0);
    const sign = n < 0 ? '-' : '';
    n = Math.abs(n);

    const units = [
      ['', 1],
      ['k', 1e3],
      ['M', 1e6],
      ['B', 1e9],
      ['T', 1e12],
      ['Qa', 1e15],
      ['Qi', 1e18],
      ['Sx', 1e21],
      ['Sp', 1e24],
      ['Oc', 1e27],
      ['No', 1e30],
      ['Dc', 1e33],
    ];

    let u = units[0];
    for (let i = units.length - 1; i >= 0; i--) {
      if (n >= units[i][1]) {
        u = units[i];
        break;
      }
    }
    const val = u[1] === 1 ? n : n / u[1];
    const d = val >= 100 ? 0 : val >= 10 ? 1 : digits;
    return `${sign}${val.toFixed(d)}${u[0]}`;
  }

  function fmtPct(v, digits = 1) {
    v = safeNum(v, 0);
    return `${(v * 100).toFixed(digits)}%`;
  }

  function fmtETA(seconds) {
    seconds = safeNum(seconds, Infinity);
    if (!Number.isFinite(seconds)) return '∞';
    if (seconds < 1) return '<1s';
    if (seconds < 60) return `${Math.ceil(seconds)}s`;
    const m = Math.floor(seconds / 60);
    const s = Math.ceil(seconds - m * 60);
    if (m < 60) return `${m}m ${s}s`;
    const h = Math.floor(m / 60);
    const mm = m - h * 60;
    if (h < 48) return `${h}h ${mm}m`;
    const d = Math.floor(h / 24);
    const hh = h - d * 24;
    return `${d}d ${hh}h`;
  }

  function addStyle(cssText) {
    const el = document.createElement('style');
    el.textContent = cssText;
    document.documentElement.appendChild(el);
    return el;
  }

  // ---------- Bridge Injection ----------
  function injectBridge() {
    if (window[APP.bridgeKey]) return;

    const code = function (BRIDGE_KEY) {
      try {
        if (window[BRIDGE_KEY]) return;

        const RES_LIST = [
          ['surface', 'land'],
          ['colony', 'metal'],
          ['colony', 'water'],
          ['colony', 'glass'],
          ['colony', 'superalloys'],
          ['colony', 'silicon'],
          ['colony', 'food'],
          ['colony', 'energy'],
          ['colony', 'electronics'],
          ['colony', 'androids'],
          ['colony', 'colonists'],
          ['colony', 'workers'],
          ['colony', 'components'],
        ];

        const STRUCT_CANDIDATES = [
          // Colonies
          't1_colony',
          't2_colony',
          't3_colony',
          't4_colony',
          't5_colony',
          't6_colony',
          't7_colony',

          // Production chain for eco build + happiness + pop seeding
          'oreMine',
          'recyclingFacility',
          'waterPump',
          'sandQuarry',
          'glassSmelter',
          'superalloyFoundry',
          'electronicsFactory',
          'androidFactory',
          'cloningFacility',
          'hydroponicFarm',

          // Energy options
          'dysonReceiver',
          'fusionPowerPlant',
          'nuclearPowerPlant',
          'geothermalGenerator',
          'windTurbine',
          'solarPanel',
        ];

        function getRoot() {
          const res = (typeof resources !== 'undefined' ? resources : globalThis.resources) || null;
          const bld = (typeof buildings !== 'undefined' ? buildings : globalThis.buildings) || null;
          const cols = (typeof colonies !== 'undefined' ? colonies : globalThis.colonies) || null;
          const pop = (typeof populationModule !== 'undefined' ? populationModule : globalThis.populationModule) || null;
          const structs = (typeof structures !== 'undefined' ? structures : globalThis.structures) || null;
          const ge = (typeof globalEffects !== 'undefined' ? globalEffects : globalThis.globalEffects) || null;
          return { res, bld, cols, pop, structs, ge };
        }

        function safeNum(n, d = 0) {
          return Number.isFinite(n) ? n : d;
        }

        function pickStructure(key, root) {
          const s = root.structs && root.structs[key];
          if (s) return s;
          const c = root.cols && root.cols[key];
          if (c) return c;
          const b = root.bld && root.bld[key];
          if (b) return b;
          return null;
        }

        function resSnapshot(root) {
          const out = {};
          for (const [cat, name] of RES_LIST) {
            const r = root.res?.[cat]?.[name];
            if (!r) continue;
            out[`${cat}.${name}`] = {
              v: safeNum(r.value),
              cap: safeNum(r.cap),
              prod: safeNum(r.productionRate),
              cons: safeNum(r.consumptionRate),
              res: safeNum(r.reserved),
              displayName: r.displayName || name,
            };
          }

          // land reserved breakdown
          const land = root.res?.surface?.land;
          const breakdown = [];
          if (land && land.reservedSources && typeof land.reservedSources === 'object') {
            for (const [k, v] of Object.entries(land.reservedSources)) {
              if (!Number.isFinite(v) || v <= 0) continue;
              breakdown.push([k, v]);
            }
            breakdown.sort((a, b) => b[1] - a[1]);
          }

          out.__landBreakdown = breakdown.slice(0, 10);
          return out;
        }

        function structureSnapshot(root) {
          const out = {};
          for (const key of STRUCT_CANDIDATES) {
            const s = pickStructure(key, root);
            if (!s) continue;
            out[key] = {
              key,
              name: s.name || key,
              displayName: s.displayName || s.name || key,
              count: safeNum(s.count),
              active: safeNum(s.active),
              unlocked: !!s.unlocked,
              requiresLand: safeNum(s.requiresLand),
              landAffordCount: typeof s.landAffordCount === 'function' ? safeNum(s.landAffordCount()) : 0,
              maxBuildable: typeof s.maxBuildable === 'function' ? safeNum(s.maxBuildable(0)) : 0,
              canAfford1: typeof s.canAfford === 'function' ? !!s.canAfford(1) : false,
              happiness: safeNum(s.happiness),
              comfort: typeof s.getComfort === 'function' ? safeNum(s.getComfort()) : safeNum(s.baseComfort),
              filledNeeds: s.filledNeeds ? { ...s.filledNeeds } : null,
              luxury: s.luxuryResourcesEnabled ? { ...s.luxuryResourcesEnabled } : null,
              storageColonists: safeNum(s.storage?.colony?.colonists),
              storageAndroids: safeNum(s.storage?.colony?.androids),
            };
          }
          return out;
        }

        function getCostBlockers(root, key, buildCount = 1) {
          const s = pickStructure(key, root);
          if (!s || typeof s.getEffectiveCost !== 'function') return [];
          const blockers = [];

          const cost = s.getEffectiveCost(buildCount) || {};
          for (const cat in cost) {
            for (const resName in cost[cat]) {
              const need = safeNum(cost[cat][resName]);
              if (need <= 0) continue;
              const r = root.res?.[cat]?.[resName];
              const have = r ? safeNum(r.value - r.reserved) : 0;
              if (have + 1e-12 < need) {
                blockers.push({
                  type: 'resource',
                  key: `${cat}.${resName}`,
                  category: cat,
                  resource: resName,
                  need,
                  have,
                  missing: need - have,
                });
              }
            }
          }

          if (s.requiresLand) {
            const land = root.res?.surface?.land;
            const haveLand = land ? safeNum(land.value - land.reserved) : 0;
            const needLand = safeNum(s.requiresLand) * buildCount;
            if (haveLand + 1e-12 < needLand) {
              blockers.push({
                type: 'land',
                key: 'surface.land',
                category: 'surface',
                resource: 'land',
                need: needLand,
                have: haveLand,
                missing: needLand - haveLand,
              });
            }
          }

          return blockers;
        }

        function buildStructureByKey(key, count = 1, activate = true) {
          const root = getRoot();
          const s = pickStructure(key, root);
          if (!s || typeof s.build !== 'function') {
            return { ok: false, error: 'structure_not_found' };
          }
          count = Math.max(1, Math.floor(count));
          try {
            const ok = s.build(count, !!activate);
            return { ok: !!ok };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        }

        function setActive(key, targetActive) {
          const root = getRoot();
          const s = pickStructure(key, root);
          if (!s) return { ok: false, error: 'structure_not_found' };

          const desired = Math.max(0, Math.min(Math.floor(targetActive), Math.floor(s.count || 0)));
          const current = Math.floor(s.active || 0);
          const delta = desired - current;
          if (delta === 0) return { ok: true };

          try {
            if (s.requiresLand && typeof s.adjustLand === 'function') {
              let d = delta;
              if (d > 0 && typeof s.landAffordCount === 'function') {
                d = Math.min(d, s.landAffordCount());
              }
              if (d !== 0) s.adjustLand(d);
            }
            const newActive = Math.max(0, Math.min(current + delta, Math.floor(s.count || 0)));
            s.active = newActive;
            if (typeof s.updateResourceStorage === 'function') s.updateResourceStorage(root.res);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        }

        function setLuxury(key, resourceName, enabled) {
          const root = getRoot();
          const s = pickStructure(key, root);
          if (!s || !s.luxuryResourcesEnabled) return { ok: false, error: 'not_supported' };
          try {
            s.luxuryResourcesEnabled[resourceName] = !!enabled;
            if (typeof s.rebuildFilledNeeds === 'function') s.rebuildFilledNeeds();
            if (typeof globalThis.invalidateColonyNeedCache === 'function') globalThis.invalidateColonyNeedCache();
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        }

        function scrollTo(key) {
          try {
            const btn = document.getElementById(`build-${key}`);
            const row = btn ? btn.closest('.building-row, .combined-building-row') : null;
            const el = row || btn;
            if (!el) return { ok: false, error: 'not_found' };
            el.scrollIntoView({ behavior: 'smooth', block: 'center' });
            el.classList.add('ttgo-flash');
            setTimeout(() => el.classList.remove('ttgo-flash'), 900);
            return { ok: true };
          } catch (e) {
            return { ok: false, error: String(e?.message || e) };
          }
        }

        function snapshot() {
          const root = getRoot();
          const ok = !!(root.res && (root.bld || root.structs) && root.pop);
          const pop = root.pop;

          const popInfo = pop
            ? {
                growthPerSec:
                  typeof pop.getCurrentGrowthPerSecond === 'function' ? safeNum(pop.getCurrentGrowthPerSecond()) : 0,
                growthPct:
                  typeof pop.getCurrentGrowthPercent === 'function' ? safeNum(pop.getCurrentGrowthPercent()) : 0,
                starvationShortage: safeNum(pop.starvationShortage),
                energyShortage: safeNum(pop.energyShortage),
                componentsCoverage: safeNum(pop.componentsCoverage, 1),
                gravityDecayRate: safeNum(pop.gravityDecayRate),
              }
            : null;

          return {
            ok,
            ts: Date.now(),
            resources: resSnapshot(root),
            structures: structureSnapshot(root),
            pop: popInfo,
          };
        }

        window[BRIDGE_KEY] = {
          version: '1.0',
          snapshot,
          getCostBlockers: (key, count) => getCostBlockers(getRoot(), key, count),
          build: buildStructureByKey,
          setActive,
          setLuxury,
          scrollTo,
        };
      } catch (e) {
        // swallow
      }
    };

    const el = document.createElement('script');
    el.textContent = `;(${code.toString()})(${JSON.stringify(APP.bridgeKey)});`;
    document.documentElement.appendChild(el);
    el.remove();
  }

  function getBridge() {
    return window[APP.bridgeKey] || null;
  }

  // ---------- Settings ----------
  function loadSettings() {
    try {
      const raw = localStorage.getItem(APP.storageKey);
      if (!raw) return null;
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  function saveSettings(s) {
    try {
      localStorage.setItem(APP.storageKey, JSON.stringify(s));
    } catch {
      // ignore
    }
  }

  const settings = Object.assign(
    {
      minimized: false,
      targetLandPct: 100,
      actionCadenceSec: 10, // "make next district affordable within Xs" for build recommendations
      fillTarget: 0.999, // 99.9%
      dock: { right: 8, top: 64, width: 380, height: 0 }, // height computed
    },
    loadSettings() || {}
  );

  // ---------- UI ----------
  const CSS = `
#${APP.uiId}{
  position:fixed;
  z-index:999999;
  right:${settings.dock.right}px;
  top:${settings.dock.top}px;
  width:${settings.dock.width}px;
  max-height: calc(100vh - ${settings.dock.top + 12}px);
  background: rgba(28,34,42,0.95);
  color: #e9eef5;
  border: 1px solid rgba(255,255,255,0.10);
  border-radius: 12px;
  box-shadow: 0 10px 30px rgba(0,0,0,0.35);
  font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, "Apple Color Emoji","Segoe UI Emoji";
  overflow:hidden;
  pointer-events:auto;
}
#${APP.uiId} .ttgo-header{
  display:flex;
  align-items:center;
  justify-content:space-between;
  padding:10px 10px 8px 10px;
  background: rgba(255,255,255,0.04);
  border-bottom: 1px solid rgba(255,255,255,0.08);
  user-select:none;
  cursor: move;
}
#${APP.uiId} .ttgo-title{
  display:flex;
  flex-direction:column;
  gap:2px;
}
#${APP.uiId} .ttgo-title .main{
  font-weight:700;
  font-size:14px;
  line-height:1.1;
}
#${APP.uiId} .ttgo-title .sub{
  font-size:12px;
  opacity:0.85;
}
#${APP.uiId} .ttgo-btn{
  background: rgba(255,255,255,0.07);
  color:#e9eef5;
  border:1px solid rgba(255,255,255,0.12);
  border-radius: 10px;
  padding:6px 10px;
  font-size:12px;
  cursor:pointer;
}
#${APP.uiId} .ttgo-btn:hover{ background: rgba(255,255,255,0.12); }
#${APP.uiId} .ttgo-body{ padding:10px; display:flex; flex-direction:column; gap:10px; }
#${APP.uiId}.minimized{
  width: 280px;
  max-height: 60px;
}
#${APP.uiId}.minimized .ttgo-body{ display:none; }
#${APP.uiId} .ttgo-card{
  background: rgba(255,255,255,0.04);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
  padding:10px;
}
#${APP.uiId} .ttgo-row{ display:flex; align-items:center; justify-content:space-between; gap:10px; }
#${APP.uiId} .ttgo-row .label{ font-size:12px; opacity:0.9; }
#${APP.uiId} .ttgo-row .value{ font-size:12px; font-weight:600; }
#${APP.uiId} .ttgo-goal{
  display:grid;
  grid-template-columns: 1fr auto;
  gap:10px;
  align-items:center;
}
#${APP.uiId} input[type="range"]{ width: 100%; }
#${APP.uiId} input[type="number"]{
  width:70px;
  padding:6px 8px;
  border-radius:10px;
  border:1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.25);
  color:#e9eef5;
}
#${APP.uiId} .ttgo-tip{
  border-left: 3px solid rgba(255,193,7,0.9);
  padding:8px 10px;
  font-size:12px;
  line-height:1.35;
  background: rgba(255,193,7,0.10);
  border-radius: 10px;
}
#${APP.uiId} .ttgo-actions{
  display:flex;
  flex-direction:column;
  gap:8px;
}
#${APP.uiId} .ttgo-action{
  display:flex;
  gap:10px;
  align-items:flex-start;
  justify-content:space-between;
  padding:10px;
  background: rgba(0,0,0,0.18);
  border: 1px solid rgba(255,255,255,0.08);
  border-radius: 12px;
}
#${APP.uiId} .ttgo-action .left{ flex:1; min-width:0; }
#${APP.uiId} .ttgo-action .name{
  font-size:13px;
  font-weight:700;
  margin-bottom:3px;
}
#${APP.uiId} .ttgo-action .why{
  font-size:12px;
  opacity:0.9;
  line-height:1.35;
  white-space:normal;
}
#${APP.uiId} .ttgo-action .meta{
  margin-top:6px;
  font-size:12px;
  opacity:0.85;
  display:flex;
  gap:10px;
  flex-wrap:wrap;
}
#${APP.uiId} .ttgo-action .right{
  display:flex;
  flex-direction:column;
  gap:6px;
  align-items:flex-end;
}
#${APP.uiId} .ttgo-small{
  font-size:12px;
  opacity:0.85;
}
#${APP.uiId} .ttgo-pill{
  display:inline-flex;
  gap:8px;
  align-items:center;
  padding:6px 10px;
  border-radius: 999px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.10);
}
.ttgo-flash{
  outline: 2px solid rgba(255,193,7,0.75);
  outline-offset: 3px;
  border-radius: 8px;
  transition: outline 0.2s ease;
}
`;

  addStyle(CSS);

  function createUI() {
    const root = document.createElement('div');
    root.id = APP.uiId;
    if (settings.minimized) root.classList.add('minimized');

    root.innerHTML = `
      <div class="ttgo-header">
        <div class="ttgo-title">
          <div class="main">TT Growth Optimizer</div>
          <div class="sub">Land% target → Ecumenopolis → full Colonists + Androids</div>
        </div>
        <button class="ttgo-btn" id="ttgo-min-btn">${settings.minimized ? 'Expand' : 'Minimize'}</button>
      </div>
      <div class="ttgo-body">
        <div class="ttgo-card">
          <div class="ttgo-row" style="margin-bottom:8px;">
            <div class="label"><strong>Goal</strong> (Land% reserved for Ecumenopolis)</div>
            <button class="ttgo-btn" id="ttgo-use-current">Use current %</button>
          </div>
          <div class="ttgo-goal">
            <div>
              <div class="ttgo-row" style="margin-bottom:6px;">
                <div class="label">Target Land %</div>
                <div class="value" id="ttgo-goal-label">—</div>
              </div>
              <input type="range" min="1" max="100" step="1" id="ttgo-goal-range" />
            </div>
            <div>
              <input type="number" min="1" max="100" step="1" id="ttgo-goal-num" />
            </div>
          </div>
          <div class="ttgo-tip" style="margin-top:10px;">
            <strong>Tip:</strong> districts can be built ahead of time, and <em>kept active</em>.
            Active-but-empty Ecumenopolis districts raise your population cap, which boosts logistic growth
            (<code>capacity factor = (1 - pop/cap)</code>).
          </div>
        </div>

        <div class="ttgo-card">
          <div class="ttgo-row" style="margin-bottom:8px;">
            <div class="label"><strong>Quick status</strong></div>
            <div class="ttgo-small" id="ttgo-status-badges">—</div>
          </div>
          <div class="ttgo-row"><div class="label">Ecumenopolis</div><div class="value" id="ttgo-eco-line">—</div></div>
          <div class="ttgo-row"><div class="label">Colonists</div><div class="value" id="ttgo-col-line">—</div></div>
          <div class="ttgo-row"><div class="label">Androids</div><div class="value" id="ttgo-and-line">—</div></div>
          <div class="ttgo-row"><div class="label">Growth</div><div class="value" id="ttgo-growth-line">—</div></div>
        </div>

        <div class="ttgo-card">
          <div class="ttgo-row" style="margin-bottom:8px;">
            <div class="label"><strong>What to do next</strong></div>
            <div class="ttgo-small" id="ttgo-last-updated">—</div>
          </div>
          <div class="ttgo-actions" id="ttgo-actions"></div>
        </div>

        <div class="ttgo-card">
          <div class="ttgo-row">
            <div class="label"><strong>Land usage</strong></div>
            <div class="value" id="ttgo-land-line">—</div>
          </div>
          <div class="ttgo-small" id="ttgo-land-breakdown" style="margin-top:6px; line-height:1.35; opacity:0.85;"></div>
        </div>
      </div>
    `;

    document.body.appendChild(root);
    return root;
  }

  const ui = createUI();

  // Drag (header-only)
  (function enableDrag() {
    const header = ui.querySelector('.ttgo-header');
    let dragging = false;
    let startX = 0, startY = 0, startRight = 0, startTop = 0;

    header.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      dragging = true;
      startX = e.clientX;
      startY = e.clientY;
      const rect = ui.getBoundingClientRect();
      startTop = rect.top;
      startRight = window.innerWidth - rect.right;
      e.preventDefault();
    });

    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - startX;
      const dy = e.clientY - startY;

      const newTop = clamp(startTop + dy, 8, window.innerHeight - 60);
      const newRight = clamp(startRight - dx, 8, window.innerWidth - 180);

      ui.style.top = `${newTop}px`;
      ui.style.right = `${newRight}px`;
    });

    window.addEventListener('mouseup', () => {
      if (!dragging) return;
      dragging = false;

      const rect = ui.getBoundingClientRect();
      settings.dock.top = Math.round(rect.top);
      settings.dock.right = Math.round(window.innerWidth - rect.right);
      settings.dock.width = Math.round(rect.width);
      saveSettings(settings);
    });
  })();

  // UI handlers
  ui.querySelector('#ttgo-min-btn').addEventListener('click', () => {
    settings.minimized = !settings.minimized;
    ui.classList.toggle('minimized', settings.minimized);
    ui.querySelector('#ttgo-min-btn').textContent = settings.minimized ? 'Expand' : 'Minimize';
    saveSettings(settings);
  });

  const rangeEl = ui.querySelector('#ttgo-goal-range');
  const numEl = ui.querySelector('#ttgo-goal-num');
  const goalLabel = ui.querySelector('#ttgo-goal-label');

  function setTargetLandPct(v) {
    v = clamp(Math.round(safeNum(v, 100)), 1, 100);
    settings.targetLandPct = v;
    rangeEl.value = String(v);
    numEl.value = String(v);
    goalLabel.textContent = `${v}%`;
    saveSettings(settings);
  }

  rangeEl.addEventListener('input', () => setTargetLandPct(rangeEl.value));
  numEl.addEventListener('change', () => setTargetLandPct(numEl.value));
  setTargetLandPct(settings.targetLandPct);

  // ---------- Planner ----------
  const RESOURCE_BUILDERS = {
    'colony.metal': ['oreMine', 'recyclingFacility'],
    'colony.water': ['waterPump'],
    'colony.glass': ['glassSmelter'],
    'colony.superalloys': ['superalloyFoundry'],
    'colony.silicon': ['sandQuarry'],
    'colony.food': ['hydroponicFarm'],
    'colony.electronics': ['electronicsFactory'],
    'colony.androids': ['androidFactory'],
    'colony.colonists': ['cloningFacility'], // for seeding / boosting when pop is low
    'colony.energy': ['dysonReceiver', 'fusionPowerPlant', 'nuclearPowerPlant', 'geothermalGenerator', 'windTurbine', 'solarPanel'],
  };

  function chooseBestUnlocked(structures, keys) {
    // Prefer: unlocked + has some active/counted already. Otherwise first unlocked.
    let best = null;
    for (const k of keys) {
      const s = structures[k];
      if (!s || !s.unlocked) continue;
      if (s.active > 0) return k;
      if (!best) best = k;
    }
    return best;
  }

  function getNet(res, key) {
    const r = res[key];
    if (!r) return 0;
    return safeNum(r.prod) - safeNum(r.cons);
  }

  function getAvail(res, key) {
    const r = res[key];
    if (!r) return 0;
    return Math.max(0, safeNum(r.v) - safeNum(r.res));
  }

  function estimatePerActiveFromRates(snapshot, structureKey, outResKey) {
    // Try to infer per-active output for outResKey by using productionRateBySource:
    // We don't have the full bySource map in the snapshot (kept light),
    // so instead we approximate by: current net for resource / active count of that producer *if the producer is the dominant source*
    // For reliability, if active==0 -> null.
    const s = snapshot.structures?.[structureKey];
    const r = snapshot.resources?.[outResKey];
    if (!s || !r || s.active <= 0) return null;

    // If net is negative, producer isn't helping. But this is still "some" magnitude.
    // We'll take total production as a rough upper bound by assuming consumption isn't from this producer.
    const approxProd = safeNum(r.prod);
    return approxProd / Math.max(1, s.active);
  }

  function perBuildingFallback(structureKey, outResKey) {
    // Base (unbuffed) fallback numbers from the game's default configs:
    // (Only used if we can't infer from live rates.)
    const base = {
      oreMine: { 'colony.metal': 1 },
      recyclingFacility: { 'colony.metal': 0.1 },
      waterPump: { 'colony.water': 1 },
      sandQuarry: { 'colony.silicon': 1 },
      glassSmelter: { 'colony.glass': 1 },
      superalloyFoundry: { 'colony.superalloys': 0.01 },
      electronicsFactory: { 'colony.electronics': 0.1 },
      androidFactory: { 'colony.androids': 0.1 },
      cloningFacility: { 'colony.colonists': 0.1 },
      hydroponicFarm: { 'colony.food': 5 },
      solarPanel: { 'colony.energy': 300000 },
      windTurbine: { 'colony.energy': 400000 },
      geothermalGenerator: { 'colony.energy': 10000000 },
      nuclearPowerPlant: { 'colony.energy': 500000000 },
      fusionPowerPlant: { 'colony.energy': 5000000000 },
      dysonReceiver: { 'colony.energy': 100000000000 },
    };
    return base?.[structureKey]?.[outResKey] ?? null;
  }

  function recommendBuildCount(snapshot, outResKey, missingAmount, desiredSeconds) {
    const structures = snapshot.structures || {};
    const candidates = RESOURCE_BUILDERS[outResKey] || [];
    const chosen = chooseBestUnlocked(structures, candidates) || candidates[0] || null;
    if (!chosen) return null;

    const netNow = getNet(snapshot.resources, outResKey);
    const targetNet = missingAmount / Math.max(1, desiredSeconds);
    const addNet = Math.max(0, targetNet - Math.max(0, netNow));

    if (addNet <= 0) {
      return {
        structureKey: chosen,
        count: 0,
        note: `At current net (${fmt(netNow)}/s) you’ll hit it in ${fmtETA(missingAmount / Math.max(1e-12, netNow))}.`,
      };
    }

    let perActive = estimatePerActiveFromRates(snapshot, chosen, outResKey);
    if (!perActive || perActive <= 0) perActive = perBuildingFallback(chosen, outResKey);

    if (!perActive || perActive <= 0) {
      return {
        structureKey: chosen,
        count: null,
        note: `Need +${fmt(addNet)}/s ${outResKey} but couldn’t infer per-building output.`,
      };
    }

    const count = Math.ceil(addNet / perActive);
    return {
      structureKey: chosen,
      count,
      note: `Target: make it affordable in ~${desiredSeconds}s (need +${fmt(addNet)}/s).`,
    };
  }

  function buildActionCard(action) {
    const wrap = document.createElement('div');
    wrap.className = 'ttgo-action';

    const left = document.createElement('div');
    left.className = 'left';

    const name = document.createElement('div');
    name.className = 'name';
    name.textContent = action.title;

    const why = document.createElement('div');
    why.className = 'why';
    why.textContent = action.why || '';

    const meta = document.createElement('div');
    meta.className = 'meta';
    if (action.meta && action.meta.length) {
      for (const m of action.meta) {
        const pill = document.createElement('span');
        pill.className = 'ttgo-pill';
        pill.textContent = m;
        meta.appendChild(pill);
      }
    }

    left.appendChild(name);
    if (action.why) left.appendChild(why);
    if (action.meta && action.meta.length) left.appendChild(meta);

    const right = document.createElement('div');
    right.className = 'right';

    for (const b of action.buttons || []) {
      const btn = document.createElement('button');
      btn.className = 'ttgo-btn';
      btn.textContent = b.label;
      btn.addEventListener('click', b.onClick);
      right.appendChild(btn);
    }

    wrap.appendChild(left);
    wrap.appendChild(right);
    return wrap;
  }

  function plan(snapshot) {
    const actions = [];
    const res = snapshot.resources || {};
    const structures = snapshot.structures || {};
    const pop = snapshot.pop || null;

    const eco = structures.t7_colony;
    const land = res['surface.land'];

    // Badges
    const badges = [];
    badges.push(`Game: ${snapshot.ok ? 'OK' : '…'}`);
    if (eco?.unlocked) badges.push(`Eco: unlocked`);
    else badges.push(`Eco: locked`);

    // Target districts
    const landTotal = safeNum(land?.v, 0);
    const landAvail = Math.max(0, safeNum(land?.v, 0) - safeNum(land?.res, 0));
    const landPct = landTotal > 0 ? safeNum(land?.res, 0) / landTotal : 0;

    const ecoLand = safeNum(eco?.requiresLand, 100000);
    const targetPct = clamp(settings.targetLandPct, 1, 100);
    const targetEcoActive = ecoLand > 0 ? Math.floor((landTotal * (targetPct / 100)) / ecoLand) : 0;

    const ecoBuilt = safeNum(eco?.count, 0);
    const ecoActive = safeNum(eco?.active, 0);

    // Quick Lines
    const colonists = res['colony.colonists'];
    const androids = res['colony.androids'];

    const colV = safeNum(colonists?.v, 0);
    const colCap = safeNum(colonists?.cap, 0);
    const andV = safeNum(androids?.v, 0);
    const andCap = safeNum(androids?.cap, 0);

    const colNet = getNet(res, 'colony.colonists');
    const andNet = getNet(res, 'colony.androids');

    // ------------- ACTIONS (prioritized) -------------

    // A) Ecumenopolis: activate built-but-inactive first (this is pure upside for growth)
    if (eco?.unlocked && ecoBuilt > ecoActive) {
      const delta = ecoBuilt - ecoActive;
      actions.push({
        title: `Activate Ecumenopolis ×${fmt(delta, 0)}`,
        why: `Built-but-inactive districts do nothing for caps. Keeping them active boosts colonist/android caps and speeds growth.`,
        meta: [`Eco active: ${fmt(ecoActive, 0)} → ${fmt(ecoBuilt, 0)}`],
        buttons: [
          {
            label: 'Activate',
            onClick: () => {
              const br = getBridge();
              br?.setActive?.('t7_colony', ecoBuilt);
            },
          },
          {
            label: 'Show',
            onClick: () => {
              const br = getBridge();
              br?.scrollTo?.('t7_colony');
            },
          },
        ],
      });
    }

    // B) Ecumenopolis: build + activate as many as possible now
    if (eco?.unlocked) {
      const needBuild = Math.max(0, targetEcoActive - ecoBuilt);
      const canBuildByRes = safeNum(eco.maxBuildable, 0);
      const canBuildByLand = safeNum(eco.landAffordCount, 0);
      const canBuildNow = Math.max(0, Math.min(needBuild, canBuildByRes, canBuildByLand));

      if (needBuild > 0 && canBuildNow > 0) {
        actions.push({
          title: `Build Ecumenopolis ×${fmt(canBuildNow, 0)} (now)`,
          why: `This directly increases caps. Empty-but-active districts are essentially free (consumption scales with pop/cap), but they accelerate growth.`,
          meta: [
            `Target eco active: ${fmt(targetEcoActive, 0)}`,
            `Built: ${fmt(ecoBuilt, 0)} → ${fmt(ecoBuilt + canBuildNow, 0)}`,
          ],
          buttons: [
            {
              label: 'Build',
              onClick: () => {
                const br = getBridge();
                br?.build?.('t7_colony', canBuildNow, true);
              },
            },
            {
              label: 'Show',
              onClick: () => {
                const br = getBridge();
                br?.scrollTo?.('t7_colony');
              },
            },
          ],
        });
      } else if (needBuild > 0 && canBuildNow === 0) {
        // blockers for 1 district
        const br = getBridge();
        const blockers = br?.getCostBlockers?.('t7_colony', 1) || [];
        const top = blockers.slice(0, 2);

        const blockerText = top.length
          ? top
              .map((b) => {
                const key = `${b.category}.${b.resource}`;
                return `${key} missing ${fmt(b.missing)}`;
              })
              .join(' • ')
          : 'Unknown blockers (bridge not ready)';

        const meta = [];
        for (const b of top) {
          const rKey = `${b.category}.${b.resource}`;
          if (rKey.startsWith('colony.')) {
            const net = getNet(res, rKey);
            const eta = net > 0 ? b.missing / net : Infinity;
            meta.push(`${rKey}: ETA ${fmtETA(eta)} (net ${fmt(net)}/s)`);
          }
          if (rKey === 'surface.land') {
            meta.push(`Land avail ${fmt(landAvail)} (reserved ${fmt(landPct * 100, 0)}%)`);
          }
        }

        actions.push({
          title: `Can’t build Ecumenopolis yet`,
          why: blockerText,
          meta: meta.length ? meta : [`Try: build/boost the missing resource(s)`],
          buttons: [
            {
              label: 'Show Eco',
              onClick: () => {
                const br2 = getBridge();
                br2?.scrollTo?.('t7_colony');
              },
            },
          ],
        });

        // Recommend specific producer builds for the #1 blocker (and a chain if needed)
        if (top.length) {
          const b0 = top[0];
          const rKey = `${b0.category}.${b0.resource}`;

          // Special case: land is blocked → show land breakdown so user can deactivate others
          if (rKey === 'surface.land') {
            actions.push({
              title: `Free up land reservations`,
              why: `You’re land-blocked. Deactivate other land-using colonies/structures until you can reserve ${fmt(b0.need)} land for the next Eco district.`,
              meta: [`Land short by ${fmt(b0.missing)}`],
              buttons: [],
            });
          } else {
            const rec = recommendBuildCount(snapshot, rKey, b0.missing, settings.actionCadenceSec);
            if (rec) {
              const sKey = rec.structureKey;
              const s = structures[sKey];
              const countText =
                rec.count === null ? 'some' : rec.count === 0 ? '0' : String(rec.count);

              actions.push({
                title:
                  rec.count && rec.count > 0
                    ? `Build ${s?.displayName || sKey} ×${countText}`
                    : `Wait (or boost) ${s?.displayName || sKey}`,
                why:
                  rec.count && rec.count > 0
                    ? `This is the fastest way to cover the current blocker (${rKey}).`
                    : `You’re already accumulating ${rKey}; you can just wait. If you want it faster, add more ${s?.displayName || sKey}.`,
                meta: [
                  `Blocker: ${rKey} short ${fmt(b0.missing)}`,
                  rec.note || '',
                ].filter(Boolean),
                buttons: [
                  {
                    label: 'Show',
                    onClick: () => {
                      const br2 = getBridge();
                      br2?.scrollTo?.(sKey);
                    },
                  },
                  ...(rec.count && rec.count > 0
                    ? [
                        {
                          label: 'Build',
                          onClick: () => {
                            const br2 = getBridge();
                            br2?.build?.(sKey, rec.count, true);
                          },
                        },
                      ]
                    : []),
                ],
              });

              // If we recommend Glass Smelters, check silicon net as a chain hint
              if (sKey === 'glassSmelter') {
                const siliconNet = getNet(res, 'colony.silicon');
                if (siliconNet <= 0) {
                  actions.push({
                    title: `Build Sand Quarry to feed Glass Smelters`,
                    why: `Glass Smelters consume silicon. Your silicon net is ${fmt(siliconNet)}/s, so glass will stall without more silicon.`,
                    meta: [`Silicon net: ${fmt(siliconNet)}/s`],
                    buttons: [
                      {
                        label: 'Show Sand Quarry',
                        onClick: () => getBridge()?.scrollTo?.('sandQuarry'),
                      },
                    ],
                  });
                }
              }
            }
          }
        }
      }
    } else {
      // Eco not unlocked: advise the next colony tier chain
      const t2 = structures.t2_colony;
      const t6 = structures.t6_colony;
      actions.push({
        title: `Unlock Ecumenopolis (colony chain)`,
        why: `Ecumenopolis isn’t unlocked yet. Push the colony tiers upward until you reach Metropolis → Ecumenopolis.`,
        meta: [
          `Have Permanent Outpost: ${t2?.unlocked ? 'yes' : 'no'}`,
          `Have Metropolis: ${t6?.unlocked ? 'yes' : 'no'}`,
        ],
        buttons: [
          { label: 'Show Colonies', onClick: () => getBridge()?.scrollTo?.('t1_colony') },
        ],
      });
    }

    // C) Turn ON luxury needs on Ecumenopolis (explicit instruction you asked for)
    if (eco?.unlocked && eco?.luxury) {
      if (eco.luxury.electronics === false) {
        actions.push({
          title: `Enable electronics consumption (Ecumenopolis checkbox)`,
          why: `Electronics is a luxury “need” that boosts happiness once you can supply it. Turning it on is a direct player action.`,
          meta: [`Eco electronics: OFF → ON`],
          buttons: [
            {
              label: 'Enable',
              onClick: () => getBridge()?.setLuxury?.('t7_colony', 'electronics', true),
            },
            { label: 'Show Eco', onClick: () => getBridge()?.scrollTo?.('t7_colony') },
          ],
        });
      }
      if (eco.luxury.androids === false) {
        actions.push({
          title: `Enable androids consumption (Ecumenopolis checkbox)`,
          why: `Same deal: this is a luxury need toggle. Turn it on when you can keep android net ≥ 0.`,
          meta: [`Eco androids: OFF → ON`],
          buttons: [
            {
              label: 'Enable',
              onClick: () => getBridge()?.setLuxury?.('t7_colony', 'androids', true),
            },
            { label: 'Show Eco', onClick: () => getBridge()?.scrollTo?.('t7_colony') },
          ],
        });
      }
    }

    // D) Colonists: if zero, seed with cloning facility (specific!)
    const fillTarget = clamp(settings.fillTarget, 0.5, 0.999999);
    const colTarget = colCap > 0 ? colCap * fillTarget : 0;

    if (colV <= 0.000001) {
      const clone = structures.cloningFacility;
      if (clone?.unlocked) {
        // Suggest at least 1 if none active
        const need = clone.active > 0 ? 0 : 1;
        actions.push({
          title: need > 0 ? `Build Cloning Facility ×${need}` : `Cloning Facility running`,
          why: `Population growth can’t start from 0 (it multiplies by current population). Cloning produces the first colonists so growth can take over.`,
          meta: [
            `Colonists: ${fmt(colV)} / ${fmt(colCap)} cap`,
            `Colonist net: ${fmt(colNet)}/s`,
          ],
          buttons: [
            { label: 'Show', onClick: () => getBridge()?.scrollTo?.('cloningFacility') },
            ...(need > 0
              ? [{ label: 'Build', onClick: () => getBridge()?.build?.('cloningFacility', need, true) }]
              : []),
          ],
        });
      } else {
        actions.push({
          title: `Colonists are 0 — get a colonist source`,
          why: `You need a source that increases colonists from 0 (Cloning Facility is the usual one).`,
          meta: [],
          buttons: [{ label: 'Show Colonies', onClick: () => getBridge()?.scrollTo?.('t1_colony') }],
        });
      }
    }

    // E) If growth is stalled, give concrete “fix happiness/needs” instructions
    if (colV > 0 && pop) {
      const growthPerSec = safeNum(pop.growthPerSec, 0);
      const growthPct = safeNum(pop.growthPct, 0);

      if (growthPerSec <= 0) {
        // The game’s core reasons: happiness <= 50%, or shortages (food/energy), or gravity decay.
        const foodShort = safeNum(pop.starvationShortage, 0);
        const energyShort = safeNum(pop.energyShortage, 0);

        if (foodShort > 0.001) {
          const foodNet = getNet(res, 'colony.food');
          actions.push({
            title: `Fix food shortage (build farms)`,
            why: `Your colonist growth is being killed by starvation pressure. Increase food net until it stays ≥ 0.`,
            meta: [
              `Food net: ${fmt(foodNet)}/s`,
              `Shortage: ${(foodShort * 100).toFixed(1)}%`,
            ],
            buttons: [{ label: 'Show Farm', onClick: () => getBridge()?.scrollTo?.('hydroponicFarm') }],
          });
        }
        if (energyShort > 0.001) {
          const eNet = getNet(res, 'colony.energy');
          const pick = chooseBestUnlocked(structures, RESOURCE_BUILDERS['colony.energy'] || []);
          actions.push({
            title: `Fix energy shortage (build power)`,
            why: `Energy shortage causes population decay / stalls growth. Add power until energy net stays ≥ 0.`,
            meta: [
              `Energy net: ${fmt(eNet)}/s`,
              `Shortage: ${(energyShort * 100).toFixed(1)}%`,
              pick ? `Suggested: ${structures[pick]?.displayName || pick}` : '',
            ].filter(Boolean),
            buttons: pick
              ? [
                  { label: 'Show', onClick: () => getBridge()?.scrollTo?.(pick) },
                ]
              : [],
          });
        }

        if (foodShort <= 0.001 && energyShort <= 0.001) {
          actions.push({
            title: `Growth stalled: raise happiness above 50%`,
            why: `If Food/Energy aren’t the issue, your weighted happiness is likely ≤ 50%. For Ecumenopolis, turning on + supplying luxuries (electronics/androids) is the usual fix.`,
            meta: [
              `Growth: ${fmt(growthPerSec)}/s (${growthPct.toFixed(2)}%/s)`,
            ],
            buttons: [{ label: 'Show Eco', onClick: () => getBridge()?.scrollTo?.('t7_colony') }],
          });
        }
      }
    }

    // F) Androids: if net <= 0, tell exactly what to build (or what to toggle)
    const andTarget = andCap > 0 ? andCap * fillTarget : 0;
    if (andCap > 0 && andV < andTarget && andNet <= 0) {
      const af = structures.androidFactory;
      actions.push({
        title: `Androids not filling → build Androids Factory`,
        why: `Your android net is ${fmt(andNet)}/s, so androids can’t rise toward cap. Add factories (or disable android luxury on colonies until you’re ready).`,
        meta: [
          `Androids: ${fmt(andV)} / ${fmt(andCap)} cap`,
          `Net: ${fmt(andNet)}/s`,
        ],
        buttons: [
          { label: 'Show Factory', onClick: () => getBridge()?.scrollTo?.('androidFactory') },
          ...(af?.unlocked
            ? [{ label: 'Build 1', onClick: () => getBridge()?.build?.('androidFactory', 1, true) }]
            : []),
        ],
      });
    }

    // If no actions, add a friendly default
    if (!actions.length) {
      actions.push({
        title: `Waiting for game state…`,
        why: `Once the bridge sees resources/colonies, I’ll give concrete build/activate steps.`,
        meta: [],
        buttons: [],
      });
    }

    return {
      actions,
      badges,
      lines: {
        eco: eco?.unlocked
          ? `target ${fmt(targetEcoActive, 0)} | built ${fmt(ecoBuilt, 0)} | active ${fmt(ecoActive, 0)}`
          : `locked`,
        col: `${fmt(colV)} / ${fmt(colCap)} (target ~${fmt(colTarget)})  | net ${fmt(colNet)}/s`,
        and: `${fmt(andV)} / ${fmt(andCap)} (target ~${fmt(andTarget)}) | net ${fmt(andNet)}/s`,
        growth: pop
          ? `${fmt(pop.growthPerSec)}/s (${safeNum(pop.growthPct, 0).toFixed(2)}%/s)`
          : '—',
        land: landTotal > 0
          ? `${fmt(landPct * 100, 0)}% reserved | ${fmt(landAvail)} free`
          : '—',
        landBreakdown: (res.__landBreakdown || [])
          .map(([k, v]) => `• ${k}: ${fmt(v)} land`)
          .join('\n'),
        currentLandPct: landTotal > 0 ? Math.round(landPct * 100) : null,
      },
      targetEcoActive,
    };
  }

  // ---------- Render loop ----------
  function render(snapshot, planOut) {
    ui.querySelector('#ttgo-last-updated').textContent = `Updated: ${new Date(snapshot.ts).toLocaleTimeString()}`;

    ui.querySelector('#ttgo-status-badges').textContent = planOut.badges.join(' • ');
    ui.querySelector('#ttgo-eco-line').textContent = planOut.lines.eco;
    ui.querySelector('#ttgo-col-line').textContent = planOut.lines.col;
    ui.querySelector('#ttgo-and-line').textContent = planOut.lines.and;
    ui.querySelector('#ttgo-growth-line').textContent = planOut.lines.growth;
    ui.querySelector('#ttgo-land-line').textContent = planOut.lines.land;

    const bd = ui.querySelector('#ttgo-land-breakdown');
    bd.textContent = planOut.lines.landBreakdown || '—';

    // actions
    const list = ui.querySelector('#ttgo-actions');
    list.textContent = '';
    for (const a of planOut.actions.slice(0, 8)) {
      list.appendChild(buildActionCard(a));
    }

    // goal label
    goalLabel.textContent = `${settings.targetLandPct}%`;

    // "Use current %" button logic
    const useCurrentBtn = ui.querySelector('#ttgo-use-current');
    useCurrentBtn.disabled = planOut.lines.currentLandPct == null;
  }

  ui.querySelector('#ttgo-use-current').addEventListener('click', () => {
    const br = getBridge();
    const snap = br?.snapshot?.();
    if (!snap?.ok) return;
    const land = snap.resources?.['surface.land'];
    const pct = land?.v > 0 ? Math.round((land.res || 0) / land.v * 100) : null;
    if (pct) setTargetLandPct(pct);
  });

  // ---------- Main Tick ----------
  injectBridge();

  let lastSnapTs = 0;

  function tick() {
    try {
      injectBridge();
      const br = getBridge();
      const snap = br?.snapshot?.();
      if (!snap || !snap.ts) return;

      // Avoid repainting too aggressively
      if (snap.ts === lastSnapTs) return;
      lastSnapTs = snap.ts;

      const out = plan(snap);
      render(snap, out);
    } catch {
      // ignore
    }
  }

  // Start
  const interval = setInterval(tick, 500);
  tick();

})();
