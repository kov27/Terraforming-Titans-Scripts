// ==UserScript==
// @name         Terraforming Titans - TT Growth Optimizer (Docked Right + Specific Actions)
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.4.1
// @description  Docked-right overlay that gives SPECIFIC next actions (build/enable/fix blockers) for fastest path to a Land%-target Ecumenopolis + full Colonists & Androids. Minimized mode is a tiny button.
// @author       kov27
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  /********************************************************************
   * Storage
   ********************************************************************/
  const LS_KEY = "TTGO_v041";
  const DEFAULTS = {
    landPct: 100,
    minimized: false,
    detailsOpen: false,
  };

  function loadCfg() {
    try {
      const raw = localStorage.getItem(LS_KEY);
      const parsed = raw ? JSON.parse(raw) : {};
      return { ...DEFAULTS, ...parsed };
    } catch {
      return { ...DEFAULTS };
    }
  }
  function saveCfg(cfg) {
    try { localStorage.setItem(LS_KEY, JSON.stringify(cfg)); } catch {}
  }

  /********************************************************************
   * Bridge (page-context safe snapshot)
   ********************************************************************/
  function injectBridge() {
    if (window.__TTGO_BRIDGE__) return;

    const code = `
      (function(){
        if (window.__TTGO_BRIDGE__) return;

        function num(x, d=0){ const n = Number(x); return Number.isFinite(n) ? n : d; }
        function bool(x){ return !!x; }

        function pickResource(category, name){
          try {
            const r = (typeof resources !== 'undefined') ? (resources?.[category]?.[name]) : null;
            if (!r) return null;
            return {
              v: num(r.value),
              cap: num(r.cap),
              reserved: num(r.reserved),
              prod: num(r.productionRate),
              cons: num(r.consumptionRate),
            };
          } catch { return null; }
        }

        function perActiveRate(struct, mode, category, resource){
          if (!struct) return 0;

          try {
            const prodMult = (typeof struct.getEffectiveProductionMultiplier === 'function')
              ? num(struct.getEffectiveProductionMultiplier(), 1) : 1;
            const consMult = (typeof struct.getEffectiveConsumptionMultiplier === 'function')
              ? num(struct.getEffectiveConsumptionMultiplier(), 1) : 1;

            const pr = (typeof struct.getProductionRatio === 'function') ? num(struct.getProductionRatio(), 1) : 1;
            const cr = (typeof struct.getConsumptionRatio === 'function') ? num(struct.getConsumptionRatio(), 1) : 1;

            const prodResMult = (typeof struct.getEffectiveResourceProductionMultiplier === 'function')
              ? num(struct.getEffectiveResourceProductionMultiplier(category, resource), 1) : 1;
            const consResMult = (typeof struct.getEffectiveResourceConsumptionMultiplier === 'function')
              ? num(struct.getEffectiveResourceConsumptionMultiplier(category, resource), 1) : 1;

            const productivity = (struct.active > 0 && Number.isFinite(struct.productivity))
              ? num(struct.productivity, 1) : 1;

            if (mode === 'prod') {
              const base = num(struct.production?.[category]?.[resource], 0);
              return base * prodMult * prodResMult * pr * productivity;
            }

            // consumption: prefer getConsumption() if present
            let consObj = null;
            if (typeof struct.getConsumption === 'function') consObj = struct.getConsumption();
            const base = num(consObj?.[category]?.[resource] ?? struct.consumption?.[category]?.[resource], 0);
            return base * consMult * consResMult * cr * productivity;
          } catch {
            return 0;
          }
        }

        function pickStructure(collection, id){
          try {
            const s = collection?.[id];
            if (!s) return null;

            let effCost = null;
            try {
              if (typeof s.getEffectiveCost === 'function') effCost = s.getEffectiveCost(1);
              else effCost = s.cost || null;
            } catch { effCost = s.cost || null; }

            let maxBuild = null;
            try {
              if (typeof s.getAutoBuildMaxCount === 'function') maxBuild = s.getAutoBuildMaxCount(0, null);
              else if (typeof s.maxBuildable === 'function') maxBuild = s.maxBuildable(0, null);
              else maxBuild = null;
            } catch { maxBuild = null; }

            return {
              id,
              name: s.displayName || s.name || id,
              unlocked: bool(s.unlocked),
              count: num(s.count),
              active: num(s.active),
              requiresLand: num(s.requiresLand),
              requiresWorker: num(s.requiresWorker),
              storageColonists: num(s.storage?.colony?.colonists),
              storageAndroids: num(s.storage?.colony?.androids),
              filledNeeds: Object.assign({}, s.filledNeeds || {}),
              luxuryEnabled: Object.assign({}, s.luxuryResourcesEnabled || {}),
              happiness: num(s.happiness),
              productivity: num(s.productivity),
              effCost1: effCost,
              maxBuildableNow: (maxBuild === null ? null : Math.max(0, Math.floor(num(maxBuild)))),
            };
          } catch {
            return null;
          }
        }

        function pickBuildingRates(buildingObj, id, keys){
          const s = buildingObj?.[id];
          if (!s) return null;
          const out = {};
          for (const k of keys) {
            const cat = k[0], res = k[1];
            out[cat + '.' + res] = {
              prod: perActiveRate(s, 'prod', cat, res),
              cons: perActiveRate(s, 'cons', cat, res),
            };
          }
          return out;
        }

        window.__TTGO_BRIDGE__ = {
          snapshot: function(){
            try {
              const hasCore = (typeof resources !== 'undefined') && (typeof buildings !== 'undefined') && (typeof colonies !== 'undefined');
              if (!hasCore) return { ok:false, reason:'Game objects not ready' };

              const land = pickResource('surface','land');

              const colonyRes = {
                colonists: pickResource('colony','colonists'),
                androids:  pickResource('colony','androids'),
                workers:   pickResource('colony','workers'),
                energy:    pickResource('colony','energy'),
                food:      pickResource('colony','food'),
                components:pickResource('colony','components'),
                electronics:pickResource('colony','electronics'),
                metal:     pickResource('colony','metal'),
                silicon:   pickResource('colony','silicon'),
                glass:     pickResource('colony','glass'),
                water:     pickResource('colony','water'),
                superalloys: pickResource('colony','superalloys'),
              };

              const pop = (typeof populationModule !== 'undefined' && populationModule) ? {
                growthPS: (typeof populationModule.getCurrentGrowthPerSecond === 'function')
                  ? num(populationModule.getCurrentGrowthPerSecond()) : num(populationModule.lastGrowthPerSecond),
                growthPct: (typeof populationModule.getCurrentGrowthPercent === 'function')
                  ? num(populationModule.getCurrentGrowthPercent()) : 0,
                starvationShortage: num(populationModule.starvationShortage),
                energyShortage: num(populationModule.energyShortage),
                componentsCoverage: num(populationModule.componentsCoverage, 1),
              } : null;

              const gravity = (typeof terraforming !== 'undefined' && terraforming?.celestialParameters)
                ? num(terraforming.celestialParameters.gravity) : null;

              // --- Colony tiers (IMPORTANT: needed for "Build 1x Permanent Outpost" etc.)
              const tierIds = ['t1_colony','t2_colony','t3_colony','t4_colony','t5_colony','t6_colony','t7_colony'];
              const colonyTiers = {};
              for (const id of tierIds) {
                const st = pickStructure(colonies, id);
                if (st) colonyTiers[id] = st;
              }

              // Candidate buildings we might recommend for blockers
              const keys = [
                ['colony','energy'],['colony','food'],['colony','components'],['colony','electronics'],
                ['colony','metal'],['colony','silicon'],['colony','glass'],['colony','water'],['colony','superalloys'],
                ['colony','colonists'],['colony','androids'],
              ];

              const cand = [
                'oreMine','sandQuarry','glassSmelter','waterPump','atmosphericWaterCollector',
                'recyclingFacility','scrapRecycler','junkRecycler',
                'superalloyFoundry','hydroponicFarm',
                'solarPanel','windTurbine','geothermalGenerator','nuclearPowerPlant','fusionPowerPlant','dysonReceiver','superalloyFusionReactor',
                'electronicsFactory','androidFactory','cloningFacility','componentFactory'
              ];

              const b = {};
              for (const id of cand) {
                const st = pickStructure(buildings, id);
                if (!st) continue;
                st.perActive = pickBuildingRates(buildings, id, keys);
                b[id] = st;
              }

              return {
                ok:true,
                t: Date.now(),
                resources: {
                  surface: { land },
                  colony: colonyRes
                },
                population: pop,
                gravity,
                colonies: colonyTiers,
                buildings: b
              };
            } catch(e) {
              return { ok:false, err: String(e && e.message ? e.message : e) };
            }
          }
        };
      })();
    `;

    const el = document.createElement("script");
    el.textContent = code;
    document.documentElement.appendChild(el);
    el.remove();
  }

  /********************************************************************
   * Formatting
   ********************************************************************/
  const SUFFIX = ["", "k", "M", "B", "T", "Qa", "Qi", "Sx", "Sp", "Oc", "No", "Dc", "Ud", "Dd", "Td"];
  function fmt(n, digits = 2) {
    const x = Number(n);
    if (!Number.isFinite(x)) return "—";
    const sign = x < 0 ? "-" : "";
    let v = Math.abs(x);
    if (v === 0) return "0";
    let i = 0;
    while (v >= 1000 && i < SUFFIX.length - 1) { v /= 1000; i++; }
    const d = v >= 100 ? 0 : v >= 10 ? Math.min(1, digits) : digits;
    return sign + v.toFixed(d) + SUFFIX[i];
  }
  function fmtPct(x, digits = 2) {
    const n = Number(x);
    if (!Number.isFinite(n)) return "—";
    return (n * 100).toFixed(digits) + "%";
  }
  function fmtSec(sec) {
    const s = Number(sec);
    if (!Number.isFinite(s)) return "—";
    if (s < 0) return "—";
    if (s < 1) return "<1s";
    if (s < 60) return Math.round(s) + "s";
    const m = Math.floor(s / 60);
    const r = Math.floor(s % 60);
    if (m < 60) return `${m}m ${r}s`;
    const h = Math.floor(m / 60);
    const mm = m % 60;
    if (h < 48) return `${h}h ${mm}m`;
    const d = Math.floor(h / 24);
    const hh = h % 24;
    return `${d}d ${hh}h`;
  }

  /********************************************************************
   * UI
   ********************************************************************/
  let cfg = loadCfg();
  let root, actionsUl, statusEl, noteEl, landRange, landNum, btnMin, btnCopy, detailsEl;
  let currentActionsText = "";

  function addStyles() {
    const css = `
      #ttgoPanel{
        position:fixed;
        right:10px;
        top:58px;
        width:420px;
        max-height:calc(100vh - 76px);
        z-index:2147483647;
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        color:#e9eef6;
        user-select:none;
      }
      #ttgoPanel *{ box-sizing:border-box; }

      /* MINIMIZED: tiny button that barely blocks anything */
      #ttgoPanel.ttgoMin{
        width:46px;
        height:46px;
        top:110px;
      }
      #ttgoPanel.ttgoMin #ttgoCard{ height:100%; }
      #ttgoPanel.ttgoMin #ttgoBody{ display:none; }
      #ttgoPanel.ttgoMin #ttgoHeader{
        height:46px;
        padding:0;
        justify-content:center;
      }
      #ttgoPanel.ttgoMin #ttgoTitleWrap{ display:none; }
      #ttgoPanel.ttgoMin #ttgoMinBtn{
        width:38px;
        height:38px;
        padding:0;
        border-radius:12px;
        font-weight:800;
      }

      #ttgoCard{
        background:rgba(18,22,28,0.92);
        border:1px solid rgba(255,255,255,0.10);
        border-radius:14px;
        box-shadow:0 10px 30px rgba(0,0,0,0.35);
        overflow:hidden;
      }
      #ttgoHeader{
        display:flex;
        align-items:center;
        justify-content:space-between;
        padding:10px 10px 8px 12px;
        background:linear-gradient(to bottom, rgba(255,255,255,0.06), rgba(255,255,255,0.02));
        border-bottom:1px solid rgba(255,255,255,0.08);
      }
      #ttgoTitleWrap{ display:flex; flex-direction:column; gap:2px; min-width:0; }
      #ttgoTitle{
        font-size:14px;
        font-weight:700;
        letter-spacing:0.2px;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      #ttgoSub{
        font-size:11px;
        opacity:0.85;
        white-space:nowrap;
        overflow:hidden;
        text-overflow:ellipsis;
      }
      .ttgoBtn{
        background:rgba(255,255,255,0.08);
        border:1px solid rgba(255,255,255,0.10);
        color:#e9eef6;
        border-radius:10px;
        padding:6px 10px;
        font-size:12px;
        cursor:pointer;
      }
      .ttgoBtn:hover{ background:rgba(255,255,255,0.12); }
      #ttgoBody{
        padding:10px 12px 12px 12px;
        display:flex;
        flex-direction:column;
        gap:10px;
      }

      .ttgoSection{
        background:rgba(255,255,255,0.04);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        padding:10px;
      }
      .ttgoRow{ display:flex; align-items:center; gap:10px; }
      .ttgoRow label{ font-size:12px; opacity:0.9; width:110px; }
      .ttgoRow input[type="range"]{ flex:1; }
      .ttgoRow input[type="number"]{
        width:72px;
        background:rgba(0,0,0,0.35);
        border:1px solid rgba(255,255,255,0.12);
        border-radius:8px;
        color:#e9eef6;
        padding:6px 8px;
        font-size:12px;
      }
      #ttgoTip{
        margin-top:8px;
        font-size:12px;
        line-height:1.25;
        padding:10px;
        border-radius:10px;
        background:rgba(255,210,60,0.10);
        border:1px solid rgba(255,210,60,0.35);
        color:#f4f0dc;
      }
      #ttgoActionsHdr{
        display:flex;
        align-items:center;
        justify-content:space-between;
        gap:8px;
        margin-bottom:6px;
      }
      #ttgoActionsHdr .left{
        display:flex;
        flex-direction:column;
        gap:2px;
        min-width:0;
      }
      #ttgoActionsHdr .h{
        font-size:13px;
        font-weight:700;
      }
      #ttgoActionsHdr .s{
        font-size:11px;
        opacity:0.85;
      }
      #ttgoActions{
        margin:0;
        padding-left:18px;
        display:flex;
        flex-direction:column;
        gap:6px;
      }
      #ttgoActions li{
        font-size:12px;
        line-height:1.25;
      }
      .ttgoCmd{ font-weight:800; }
      .ttgoWhy{
        display:block;
        margin-top:2px;
        opacity:0.85;
        font-size:11px;
      }
      #ttgoNote{
        margin-top:8px;
        font-size:11px;
        opacity:0.9;
        line-height:1.25;
      }
      details#ttgoDetails{
        background:rgba(0,0,0,0.18);
        border:1px solid rgba(255,255,255,0.08);
        border-radius:12px;
        padding:8px 10px;
      }
      details#ttgoDetails summary{
        cursor:pointer;
        font-size:12px;
        font-weight:700;
        opacity:0.95;
      }
      #ttgoStatus{
        margin-top:8px;
        display:grid;
        grid-template-columns: 1fr auto;
        gap:6px 10px;
        font-size:12px;
      }
      #ttgoStatus .k{ opacity:0.85; }
      #ttgoStatus .v{ text-align:right; font-variant-numeric:tabular-nums; }
      .ttgoMuted{ opacity:0.75; }
    `;
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
  }

  function buildUI() {
    root = document.createElement("div");
    root.id = "ttgoPanel";
    if (cfg.minimized) root.classList.add("ttgoMin");

    root.innerHTML = `
      <div id="ttgoCard">
        <div id="ttgoHeader">
          <div id="ttgoTitleWrap">
            <div id="ttgoTitle">TT Growth Optimizer</div>
            <div id="ttgoSub">Land% target → Ecumenopolis → full Colonists + Androids</div>
          </div>
          <button class="ttgoBtn" id="ttgoMinBtn">${cfg.minimized ? "TTGO" : "Minimize"}</button>
        </div>

        <div id="ttgoBody">
          <div class="ttgoSection">
            <div class="ttgoRow">
              <label>Target Land %</label>
              <input id="ttgoLandRange" type="range" min="0" max="100" step="1" value="${Number(cfg.landPct) || 100}">
              <input id="ttgoLandNum" type="number" min="0" max="100" step="1" value="${Number(cfg.landPct) || 100}">
              <button class="ttgoBtn" id="ttgoUseCurBtn" title="Set target to your current Ecumenopolis land% (based on ACTIVE districts).">Use current</button>
            </div>

            <div id="ttgoTip">
              Tip: districts should be <b>ACTIVE</b> even if empty. Active-but-empty districts increase your population cap (K),
              boosting logistic growth via <b>capacityFactor = (1 − pop/cap)</b>.
            </div>
          </div>

          <div class="ttgoSection">
            <div id="ttgoActionsHdr">
              <div class="left">
                <div class="h">What to do next</div>
                <div class="s" id="ttgoActionsSub">Waiting for game state…</div>
              </div>
              <div class="right" style="display:flex; gap:8px;">
                <button class="ttgoBtn" id="ttgoCopyBtn">Copy</button>
              </div>
            </div>

            <ul id="ttgoActions"></ul>
            <div id="ttgoNote" class="ttgoMuted"></div>
          </div>

          <details id="ttgoDetails" ${cfg.detailsOpen ? "open" : ""}>
            <summary>Details (numbers)</summary>
            <div id="ttgoStatus"></div>
          </details>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    actionsUl = root.querySelector("#ttgoActions");
    statusEl = root.querySelector("#ttgoStatus");
    noteEl = root.querySelector("#ttgoNote");
    landRange = root.querySelector("#ttgoLandRange");
    landNum = root.querySelector("#ttgoLandNum");
    btnMin = root.querySelector("#ttgoMinBtn");
    btnCopy = root.querySelector("#ttgoCopyBtn");
    detailsEl = root.querySelector("#ttgoDetails");

    btnMin.addEventListener("click", () => {
      cfg.minimized = !cfg.minimized;
      saveCfg(cfg);
      root.classList.toggle("ttgoMin", cfg.minimized);
      btnMin.textContent = cfg.minimized ? "TTGO" : "Minimize";
    });

    function setLandPct(v) {
      const n = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
      cfg.landPct = n;
      saveCfg(cfg);
      landRange.value = String(n);
      landNum.value = String(n);
    }

    landRange.addEventListener("input", () => setLandPct(landRange.value));
    landNum.addEventListener("change", () => setLandPct(landNum.value));

    root.querySelector("#ttgoUseCurBtn").addEventListener("click", () => {
      const s = getState();
      if (!s?.ok) return;
      const pct = computeCurrentEcoLandPct(s);
      if (Number.isFinite(pct)) setLandPct(pct);
    });

    detailsEl.addEventListener("toggle", () => {
      cfg.detailsOpen = !!detailsEl.open;
      saveCfg(cfg);
    });

    btnCopy.addEventListener("click", () => {
      const text = currentActionsText || "";
      if (!text.trim()) return;
      copyToClipboard(text);
    });
  }

  async function copyToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
      btnCopy.textContent = "Copied!";
      setTimeout(() => (btnCopy.textContent = "Copy"), 900);
    } catch {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.left = "-9999px";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); } catch {}
      ta.remove();
      btnCopy.textContent = "Copied!";
      setTimeout(() => (btnCopy.textContent = "Copy"), 900);
    }
  }

  /********************************************************************
   * State + Planning helpers
   ********************************************************************/
  function getState() {
    try {
      return window.__TTGO_BRIDGE__?.snapshot?.() || { ok: false, reason: "Bridge not ready" };
    } catch (e) {
      return { ok: false, err: String(e) };
    }
  }

  function computeCurrentEcoLandPct(s) {
    const land = s?.resources?.surface?.land;
    const t7 = s?.colonies?.t7_colony;
    if (!land || !t7) return NaN;

    const landTotal = land.v;
    const landReservedAll = land.reserved;

    const ecoLandPer = t7.requiresLand || 100000;
    const ecoLandReserved = (t7.active || 0) * ecoLandPer;

    const otherReserved = Math.max(0, landReservedAll - ecoLandReserved);
    const landAvailableForEco = Math.max(0, landTotal - otherReserved);
    if (landAvailableForEco <= 0) return 0;

    const pct = (ecoLandReserved / landAvailableForEco) * 100;
    return Math.max(0, Math.min(100, Math.round(pct)));
  }

  function netRate(res) {
    if (!res) return NaN;
    return (Number(res.prod) || 0) - (Number(res.cons) || 0);
  }

  function chooseBestProducer(s, cat, resName) {
    const b = s?.buildings || {};
    let best = null;
    let bestRate = 0;

    for (const id in b) {
      const st = b[id];
      if (!st?.unlocked) continue;
      const key = `${cat}.${resName}`;
      const r = st.perActive?.[key];
      const prod = Number(r?.prod) || 0;
      if (prod > bestRate) {
        bestRate = prod;
        best = st;
      }
    }
    return best ? { structure: best, perActiveProd: bestRate } : null;
  }

  function costMissingForOne(costObj, resourcesObj) {
    const missing = [];
    if (!costObj) return missing;

    for (const cat in costObj) {
      for (const r in costObj[cat]) {
        const need = Number(costObj[cat][r]) || 0;
        if (need <= 0) continue;

        const have = Number(resourcesObj?.[cat]?.[r]?.v) || 0;
        const reserved = Number(resourcesObj?.[cat]?.[r]?.reserved) || 0;
        const avail = Math.max(0, have - reserved);
        const miss = Math.max(0, need - avail);
        if (miss > 0) missing.push({ cat, r, need, avail, miss });
      }
    }
    return missing;
  }

  function pickColonyProgress(colonies) {
    const tiers = ["t1_colony","t2_colony","t3_colony","t4_colony","t5_colony","t6_colony","t7_colony"];
    let highestBuilt = -1;
    let highestUnlocked = -1;

    for (let i = 0; i < tiers.length; i++) {
      const c = colonies?.[tiers[i]];
      if (c?.unlocked) highestUnlocked = i;
      if ((c?.count || 0) > 0) highestBuilt = i;
    }

    if (highestBuilt >= 0) return { tiers, idx: highestBuilt, mode: "built" };
    if (highestUnlocked >= 0) return { tiers, idx: highestUnlocked, mode: "unlocked" };
    return { tiers, idx: -1, mode: "none" };
  }

  /********************************************************************
   * Planner (specific actions, no mini-goals)
   ********************************************************************/
  function computeActions(s) {
    const actions = [];
    const whyLines = [];
    const details = [];

    const land = s.resources?.surface?.land;
    const colonies = s.colonies || {};
    const R = s.resources || {};

    if (!land || !colonies) {
      actions.push({
        cmd: "Open the Colony tab (or wait 1–2 seconds)",
        why: "TTGO can’t see colony/land state yet."
      });
      return { actions, whyLines, details };
    }

    const prog = pickColonyProgress(colonies);
    const t7 = colonies.t7_colony;

    // ----- If Ecumenopolis is NOT unlocked yet: give explicit colony-chain steps -----
    if (!t7?.unlocked) {
      const curTierId = prog.idx >= 0 ? prog.tiers[prog.idx] : null;
      const nextTierId = prog.idx >= 0 ? prog.tiers[Math.min(prog.idx + 1, prog.tiers.length - 1)] : "t1_colony";

      const curTier = curTierId ? colonies[curTierId] : null;
      const nextTier = colonies[nextTierId];

      if (prog.idx < 0) {
        actions.push({
          cmd: "Build your first colony tier (Research Outpost / Starter colony)",
          why: "You need at least one colony tier built to progress toward Ecumenopolis."
        });
      } else if (!nextTier) {
        actions.push({
          cmd: "Progress colony tiers until Ecumenopolis appears (t7_colony)",
          why: "Colony tier objects not fully visible yet."
        });
      } else if (!nextTier.unlocked) {
        actions.push({
          cmd: `Unlock next colony tier: ${nextTier.name}`,
          why: `You currently have ${curTier?.name || curTierId}. Complete whatever unlocks ${nextTier.name} (research / prerequisites).`
        });
      } else {
        // next tier unlocked: tell them to build 1
        const need = Math.max(0, 1 - (nextTier.count || 0));
        if (need > 0) {
          const canBuildNow = Number.isFinite(nextTier.maxBuildableNow) ? nextTier.maxBuildableNow : 0;
          if (canBuildNow >= 1) {
            actions.push({
              cmd: `Build 1× ${nextTier.name}`,
              why: `Fastest progression step toward Ecumenopolis is advancing the colony tier chain.`
            });
          } else {
            const missing = costMissingForOne(nextTier.effCost1, R);
            if (!missing.length) {
              actions.push({
                cmd: `Build 1× ${nextTier.name} (blocked by non-resource constraint)`,
                why: `Costs look covered, but game reports 0 buildable. Check land reservations / deposits / UI constraints.`
              });
            } else {
              const blockers = missing.map(m => {
                const res = R?.[m.cat]?.[m.r];
                const rate = netRate(res);
                const eta = (rate > 0) ? (m.miss / rate) : Infinity;
                return { ...m, rate, eta };
              }).sort((a,b) => b.eta - a.eta);

              const top = blockers[0];
              actions.push({
                cmd: `Build 1× ${nextTier.name} (currently blocked by ${top.r})`,
                why: `Missing ${fmt(top.miss)} ${top.r}; net ${fmt(top.rate)}/s → ETA ${fmtSec(top.eta)}.`
              });

              // Recommend “build X of Y” to get blocker down to ~10 min
              const TARGET_SEC = 600;
              const neededRate = top.miss / TARGET_SEC;
              const extraRate = Math.max(0, neededRate - Math.max(0, top.rate));

              if (extraRate > 0) {
                const pick = chooseBestProducer(s, top.cat, top.r);
                if (pick && pick.perActiveProd > 0) {
                  const count = Math.ceil(extraRate / pick.perActiveProd);
                  const w = pick.structure.requiresWorker ? ` (needs ~${fmt(count * pick.structure.requiresWorker, 0)} workers)` : "";
                  actions.push({
                    cmd: `Build ${fmt(count,0)}× ${pick.structure.name}${w}`,
                    why: `This speeds up ${top.r} so you can afford ${nextTier.name} in ~10 minutes (needs +${fmt(extraRate)}/s).`
                  });
                } else {
                  actions.push({
                    cmd: `Increase ${top.r} production (build more producers of ${top.r})`,
                    why: `Need about +${fmt(extraRate)}/s to make the next tier a ~10 minute wait.`
                  });
                }
              }
            }
          }
        } else {
          // already have next tier built; advance again
          const next2Id = prog.tiers[Math.min(prog.idx + 2, prog.tiers.length - 1)];
          const next2 = colonies[next2Id];
          if (next2?.unlocked) {
            actions.push({
              cmd: `Build 1× ${next2.name}`,
              why: `You already have ${nextTier.name}; keep climbing colony tiers to unlock Ecumenopolis.`
            });
          } else {
            actions.push({
              cmd: `Keep progressing toward Ecumenopolis (next unlock: ${next2?.name || next2Id})`,
              why: `Next tier isn’t unlocked yet; meet its requirements.`
            });
          }
        }
      }

      // Helpful note: you can still prepare for later (electronics etc.)
      actions.push({
        cmd: "Optional prep: build Electronics production before high-tier colonies",
        why: "Higher tiers often benefit from Electronics luxuries; having net-positive electronics avoids happiness stalls."
      });

      return { actions, whyLines, details };
    }

    // ----- Ecumenopolis unlocked: do Land% target plan + fill plan -----
    const landTotal = land.v;
    const landReservedAll = land.reserved;

    const ecoLandPer = t7.requiresLand || 100000;
    const ecoActive = t7.active || 0;
    const ecoBuilt = t7.count || 0;

    const ecoLandReserved = ecoActive * ecoLandPer;
    const otherLandReserved = Math.max(0, landReservedAll - ecoLandReserved);
    const landAvailableForEco = Math.max(0, landTotal - otherLandReserved);

    const targetPct = Math.max(0, Math.min(100, Number(cfg.landPct) || 0));
    const targetEcoLand = (landAvailableForEco * targetPct) / 100;
    const targetEcoActive = Math.floor(targetEcoLand / ecoLandPer);

    // Activate built-but-inactive first
    if (ecoBuilt > ecoActive) {
      const wantActive = Math.min(ecoBuilt, targetEcoActive);
      const toActivate = Math.max(0, wantActive - ecoActive);
      if (toActivate > 0) {
        actions.push({
          cmd: `Activate Ecumenopolis districts ×${fmt(toActivate, 0)}`,
          why: "Active districts increase caps immediately (even if empty), boosting capacityFactor."
        });
      }
    }

    // Build toward target (no mini-goal language: always refers to your chosen Land% target)
    const remainingToTarget = Math.max(0, targetEcoActive - ecoBuilt);
    if (remainingToTarget > 0) {
      const canBuildNow = Number.isFinite(t7.maxBuildableNow) ? Math.max(0, t7.maxBuildableNow) : 0;
      const buildNow = Math.min(remainingToTarget, canBuildNow);

      if (buildNow > 0) {
        actions.push({
          cmd: `Build Ecumenopolis districts ×${fmt(buildNow, 0)}`,
          why: `This moves you toward your Land% target (target active eco = ${fmt(targetEcoActive, 0)}).`
        });
      } else {
        const missing = costMissingForOne(t7.effCost1, R);
        if (missing.length) {
          const blockers = missing.map(m => {
            const res = R?.[m.cat]?.[m.r];
            const rate = netRate(res);
            const eta = (rate > 0) ? (m.miss / rate) : Infinity;
            return { ...m, rate, eta };
          }).sort((a,b) => b.eta - a.eta);

          const top = blockers[0];
          actions.push({
            cmd: `Build next Ecumenopolis district (blocked by ${top.r})`,
            why: `Missing ${fmt(top.miss)} ${top.r}; net ${fmt(top.rate)}/s → ETA ${fmtSec(top.eta)}.`
          });

          const TARGET_SEC = 600;
          const neededRate = top.miss / TARGET_SEC;
          const extraRate = Math.max(0, neededRate - Math.max(0, top.rate));

          if (extraRate > 0) {
            const pick = chooseBestProducer(s, top.cat, top.r);
            if (pick && pick.perActiveProd > 0) {
              const count = Math.ceil(extraRate / pick.perActiveProd);
              const w = pick.structure.requiresWorker ? ` (needs ~${fmt(count * pick.structure.requiresWorker, 0)} workers)` : "";
              actions.push({
                cmd: `Build ${fmt(count,0)}× ${pick.structure.name}${w}`,
                why: `Speeds up ${top.r} so you can afford 1 district in ~10 minutes (needs +${fmt(extraRate)}/s).`
              });
            }
          }
        } else {
          actions.push({
            cmd: "Can’t build Ecumenopolis right now (check land reservations / constraints)",
            why: "Costs look covered, but buildable count is 0."
          });
        }
      }
    } else if (ecoActive < targetEcoActive) {
      actions.push({
        cmd: `Activate Ecumenopolis districts ×${fmt(targetEcoActive - ecoActive, 0)} (to hit Land% target)`,
        why: "Built-but-inactive districts do nothing for caps."
      });
    } else {
      actions.push({
        cmd: `Land% target achieved for Ecumenopolis (active ${fmt(ecoActive,0)} / target ${fmt(targetEcoActive,0)})`,
        why: "Next step is filling Colonists + Androids to cap."
      });
    }

    // Luxuries: recommend enabling when core needs are okay
    if (t7?.luxuryEnabled) {
      const foodNeed = Number(t7.filledNeeds?.food ?? 0);
      const energyNeed = Number(t7.filledNeeds?.energy ?? 0);
      if (foodNeed > 0.95 && energyNeed > 0.95) {
        if (t7.luxuryEnabled.electronics === false) {
          actions.push({
            cmd: "Enable Electronics consumption (Ecumenopolis luxuries toggle)",
            why: "Electronics luxury raises happiness, improving growth speed."
          });
        }
        if (t7.luxuryEnabled.androids === false) {
          actions.push({
            cmd: "Enable Androids consumption (Ecumenopolis luxuries toggle)",
            why: "Android luxury raises happiness, improving growth speed."
          });
        }
      }
    }

    // Fill: Colonists + Androids
    const col = R.colony.colonists;
    const and = R.colony.androids;

    const colNet = netRate(col);
    const andNet = netRate(and);

    if ((col?.v ?? 0) <= 0) {
      const cloning = s.buildings?.cloningFacility;
      if (cloning?.unlocked) {
        const key = "colony.colonists";
        const per = Number(cloning.perActive?.[key]?.prod) || 0.1;
        const seedTarget = 100;
        const seedTime = 60;
        const needRate = seedTarget / seedTime;
        const extra = Math.max(0, needRate - Math.max(0, colNet));
        const addCount = per > 0 ? Math.max(1, Math.ceil(extra / per)) : 1;
        const w = cloning.requiresWorker ? ` (needs ~${fmt(addCount * cloning.requiresWorker, 0)} workers)` : "";
        actions.push({
          cmd: `Build ${fmt(addCount,0)}× Cloning Facility${w}`,
          why: "Colonists at 0 → logistic growth can’t start. Cloning seeds population."
        });
      }
    }

    if (Number.isFinite(andNet) && andNet <= 0) {
      const f = s.buildings?.androidFactory;
      if (f?.unlocked) {
        const per = Number(f.perActive?.["colony.androids"]?.prod) || 0.1;
        const need = Math.max(0, (and?.cons || 0) - (and?.prod || 0)) * 1.05;
        const count = per > 0 ? Math.ceil(need / per) : 1;
        const w = f.requiresWorker ? ` (needs ~${fmt(count * f.requiresWorker, 0)} workers)` : "";
        actions.push({
          cmd: `Build ${fmt(Math.max(1,count),0)}× Android Factory${w}`,
          why: "Android net is ≤ 0, so Androids can’t fill. This makes net positive."
        });
      }
    }

    // Growth killers (food/energy shortage)
    const pop = s.population;
    if (pop) {
      if (pop.starvationShortage > 0.0005) {
        actions.push({
          cmd: "Fix Food shortage (build more farms / raise Food net ≥ 0)",
          why: `Starvation shortage ${(pop.starvationShortage*100).toFixed(1)}% will stall growth/happiness.`
        });
      }
      if (pop.energyShortage > 0.0005) {
        actions.push({
          cmd: "Fix Energy shortage (build more power / raise Energy net ≥ 0)",
          why: `Energy shortage ${(pop.energyShortage*100).toFixed(1)}% will stall growth/happiness.`
        });
      }
    }

    // Note line
    const capFactor = (() => {
      const popVal = Number(col?.v) || 0;
      const popCap = Number(col?.cap) || 0;
      if (popCap <= 0) return 0;
      const ratio = popVal / popCap;
      return ratio >= 1 ? 0 : (1 - ratio);
    })();
    whyLines.push(
      `capacityFactor (1 - pop/cap): ${fmt(capFactor, 3)} • Colonists: ${fmt(col?.v)}/${fmt(col?.cap)} • Androids: ${fmt(and?.v)}/${fmt(and?.cap)}`
    );

    // Details
    details.push(["Target Land %", `${fmt(targetPct,0)}%`]);
    details.push(["Eco target active", fmt(targetEcoActive,0)]);
    details.push(["Eco built / active", `${fmt(ecoBuilt,0)} / ${fmt(ecoActive,0)}`]);
    details.push(["Colonists net", `${fmt(colNet)}/s`]);
    details.push(["Androids net", `${fmt(andNet)}/s`]);

    return { actions, whyLines, details, targetEcoActive };
  }

  /********************************************************************
   * Render
   ********************************************************************/
  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }

  function render() {
    const s = getState();

    const sub = root.querySelector("#ttgoActionsSub");
    actionsUl.innerHTML = "";
    statusEl.innerHTML = "";
    noteEl.textContent = "";
    currentActionsText = "";

    if (!s?.ok) {
      sub.textContent = s?.reason ? String(s.reason) : (s?.err ? String(s.err) : "Waiting for game state…");
      actionsUl.innerHTML = `<li class="ttgoMuted">Open the game UI and let it run for a few seconds.</li>`;
      return;
    }

    const plan = computeActions(s);
    const landPct = Math.max(0, Math.min(100, Number(cfg.landPct) || 0));
    sub.textContent = `Land% target: ${landPct}% • Next actions: ${plan.actions.length}`;

    const lines = [];
    plan.actions.forEach((a, idx) => {
      const li = document.createElement("li");
      li.innerHTML =
        `<span class="ttgoCmd">${idx + 1}) ${escapeHtml(a.cmd)}</span>` +
        (a.why ? `<span class="ttgoWhy">${escapeHtml(a.why)}</span>` : "");
      actionsUl.appendChild(li);
      lines.push(`${idx + 1}) ${a.cmd}\n   - ${a.why || ""}`.trimEnd());
    });
    currentActionsText = lines.join("\n\n");

    if (plan.whyLines.length) noteEl.textContent = plan.whyLines.join(" • ");

    for (const [k, v] of (plan.details || [])) {
      const dk = document.createElement("div");
      dk.className = "k";
      dk.textContent = k;
      const dv = document.createElement("div");
      dv.className = "v";
      dv.textContent = v;
      statusEl.appendChild(dk);
      statusEl.appendChild(dv);
    }
  }

  /********************************************************************
   * Init
   ********************************************************************/
  function init() {
    injectBridge();
    addStyles();
    buildUI();
    render();
    setInterval(render, 400);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init, { once: true });
  } else {
    init();
  }
})();
