// ==UserScript==
// @name         TT - Growth Automation Engine
// @namespace    tt-growth-auto
// @version      4.0.0
// @description  Intelligent planet building automation - from nothing to full Ecumenopolis
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  "use strict";

  // ============ CONFIG ============
  const CFG = {
    enabled: false,
    
    // Build strategy
    targetLandPercent: 100,
    buildBatchSize: 10,        // Build structures in batches
    
    // Resource management
    maintainBufferSeconds: 60,  // Keep 60s of consumption in storage
    
    // Priority system
    priorities: {
      energy: 100,        // Always top priority
      food: 95,           // Can't grow without food
      housing: 90,        // Needed for population
      production: 80,     // Make resources
      luxury: 50,         // Quality of life
    },
    
    // Automation
    autoEnableBuildings: true,
    autoResearch: false,  // Don't auto-research (too risky)
    
    tickMs: 2000,
  };

  const log = (...args) => console.log("[Growth]", ...args);

  // ============ GAME ACCESS ============
  function getBuildings() {
    try {
      return (typeof buildings !== "undefined") ? buildings : window.buildings || null;
    } catch { return null; }
  }

  function getColonies() {
    try {
      return (typeof colonies !== "undefined") ? colonies : window.colonies || null;
    } catch { return null; }
  }

  function getResources() {
    try {
      return (typeof resources !== "undefined") ? resources : window.resources || null;
    } catch { return null; }
  }

  function getTerraforming() {
    try {
      return (typeof terraforming !== "undefined") ? terraforming : window.terraforming || null;
    } catch { return null; }
  }

  // ============ ANALYSIS ============
  function analyzeResourceState(name, category = 'colony') {
    const res = getResources();
    const r = res?.[category]?.[name];
    if (!r) return null;

    const value = r.value ?? 0;
    const cap = r.cap ?? 0;
    const prod = r.productionRate ?? 0;
    const cons = r.consumptionRate ?? 0;
    const net = prod - cons;
    
    const fillPercent = cap > 0 ? (value / cap) * 100 : 0;
    const timeToEmpty = (cons > 0 && net < 0) ? (value / Math.abs(net)) : Infinity;
    const timeToFull = (net > 0 && cap > 0) ? ((cap - value) / net) : Infinity;
    
    return {
      name,
      value,
      cap,
      prod,
      cons,
      net,
      fillPercent,
      timeToEmpty,
      timeToFull,
      critical: timeToEmpty < 120,  // Less than 2 minutes
      abundant: fillPercent > 80 && net > 0,
    };
  }

  function findBottleneck() {
    const critical = ['energy', 'food', 'colonists', 'androids'];
    const resources = ['metal', 'silicon', 'glass', 'electronics', 'components', 'water', 'superalloys'];
    
    let worst = null;
    let worstScore = Infinity;
    
    [...critical, ...resources].forEach(name => {
      const state = analyzeResourceState(name);
      if (!state) return;
      
      // Score based on urgency
      let score = state.timeToEmpty;
      if (state.critical) score *= 0.1;  // Heavily prioritize critical
      if (state.net < 0) score *= 0.5;   // Negative net is bad
      
      if (score < worstScore) {
        worstScore = score;
        worst = state;
      }
    });
    
    return worst;
  }

  // ============ BUILDING SELECTION ============
  const BUILDING_DATABASE = {
    // Energy production
    solarPanel: { produces: 'energy', priority: 100, category: 'energy' },
    windTurbine: { produces: 'energy', priority: 95, category: 'energy' },
    geothermalGenerator: { produces: 'energy', priority: 90, category: 'energy' },
    nuclearPowerPlant: { produces: 'energy', priority: 85, category: 'energy' },
    fusionPowerPlant: { produces: 'energy', priority: 80, category: 'energy' },
    
    // Food production
    hydroponicFarm: { produces: 'food', priority: 95, category: 'food' },
    
    // Basic resources
    oreMine: { produces: 'metal', priority: 85, category: 'production' },
    sandQuarry: { produces: 'silicon', priority: 85, category: 'production' },
    glassSmelter: { produces: 'glass', priority: 80, category: 'production' },
    waterPump: { produces: 'water', priority: 85, category: 'production' },
    
    // Advanced resources
    electronicsFactory: { produces: 'electronics', priority: 75, category: 'production' },
    componentFactory: { produces: 'components', priority: 75, category: 'production' },
    superalloyFoundry: { produces: 'superalloys', priority: 70, category: 'production' },
    
    // Population
    cloningFacility: { produces: 'colonists', priority: 90, category: 'housing' },
    androidFactory: { produces: 'androids', priority: 85, category: 'housing' },
  };

  function findBestBuilding(targetResource) {
    const buildings = getBuildings();
    if (!buildings) return null;
    
    // Find all buildings that produce target resource
    const candidates = [];
    
    for (const [id, info] of Object.entries(BUILDING_DATABASE)) {
      if (info.produces !== targetResource) continue;
      
      const building = buildings[id];
      if (!building) continue;
      if (!building.unlocked) continue;
      
      // Calculate production per cost
      const prod = building.production?.colony?.[targetResource] ?? 0;
      const cost = building.cost?.colony?.metal ?? 1;
      const efficiency = prod / cost;
      
      candidates.push({
        id,
        building,
        info,
        efficiency,
        priority: info.priority,
      });
    }
    
    if (candidates.length === 0) return null;
    
    // Sort by priority, then efficiency
    candidates.sort((a, b) => {
      if (Math.abs(a.priority - b.priority) > 5) {
        return b.priority - a.priority;
      }
      return b.efficiency - a.efficiency;
    });
    
    return candidates[0];
  }

  // ============ BUILD EXECUTION ============
  function canAfford(building) {
    const res = getResources();
    if (!res || !building.cost) return false;
    
    for (const category in building.cost) {
      for (const resource in building.cost[category]) {
        const needed = building.cost[category][resource];
        const have = res[category]?.[resource]?.value ?? 0;
        
        if (have < needed) return false;
      }
    }
    
    return true;
  }

  function buildStructure(buildingId, count = 1) {
    const buildings = getBuildings();
    const building = buildings?.[buildingId];
    if (!building) return false;
    
    try {
      // Try different build methods
      if (typeof building.build === "function") {
        return building.build(count);
      }
      
      if (typeof building.construct === "function") {
        return building.construct(count);
      }
      
      // Manual building
      for (let i = 0; i < count; i++) {
        if (!canAfford(building)) break;
        
        // Deduct costs
        const res = getResources();
        for (const category in building.cost) {
          for (const resource in building.cost[category]) {
            const cost = building.cost[category][resource];
            if (res[category]?.[resource]) {
              res[category][resource].value -= cost;
            }
          }
        }
        
        // Increment count
        building.count = (building.count ?? 0) + 1;
      }
      
      return true;
    } catch (err) {
      log("Build error:", err);
      return false;
    }
  }

  function enableStructure(buildingId) {
    const buildings = getBuildings();
    const building = buildings?.[buildingId];
    if (!building) return false;
    
    try {
      const count = building.count ?? 0;
      const active = building.active ?? 0;
      
      if (active >= count) return false;
      
      if (typeof building.setActive === "function") {
        building.setActive(count);
        return true;
      }
      
      building.active = count;
      return true;
    } catch (err) {
      log("Enable error:", err);
      return false;
    }
  }

  // ============ COLONY PROGRESSION ============
  function getCurrentColonyTier() {
    const colonies = getColonies();
    if (!colonies) return 0;
    
    const tiers = [
      't1_colony', 't2_colony', 't3_colony', 't4_colony',
      't5_colony', 't6_colony', 't7_colony'
    ];
    
    let highest = 0;
    tiers.forEach((tier, idx) => {
      const colony = colonies[tier];
      if (colony && colony.count > 0) {
        highest = idx + 1;
      }
    });
    
    return highest;
  }

  function buildNextColonyTier() {
    const colonies = getColonies();
    if (!colonies) return false;
    
    const tiers = [
      't1_colony', 't2_colony', 't3_colony', 't4_colony',
      't5_colony', 't6_colony', 't7_colony'
    ];
    
    const current = getCurrentColonyTier();
    if (current >= 7) return false;  // Already at Ecumenopolis
    
    const nextTier = tiers[current];
    const colony = colonies[nextTier];
    
    if (!colony || !colony.unlocked) return false;
    if (!canAfford(colony)) return false;
    
    return buildStructure(nextTier, 1);
  }

  // ============ MAIN AUTOMATION ============
  const state = {
    lastTick: 0,
    lastAction: "",
    stats: {
      structuresBuilt: 0,
      coloniesUpgraded: 0,
    },
    plan: null,
  };

  function createBuildPlan() {
    const bottleneck = findBottleneck();
    
    if (!bottleneck) {
      return { action: 'wait', reason: 'No bottlenecks detected' };
    }
    
    // Critical resource shortage
    if (bottleneck.critical) {
      const best = findBestBuilding(bottleneck.name);
      if (best) {
        return {
          action: 'build',
          building: best.id,
          count: CFG.buildBatchSize,
          reason: `CRITICAL: ${bottleneck.name} running out in ${Math.floor(bottleneck.timeToEmpty)}s`,
        };
      }
    }
    
    // Negative net
    if (bottleneck.net < 0) {
      const best = findBestBuilding(bottleneck.name);
      if (best) {
        return {
          action: 'build',
          building: best.id,
          count: Math.ceil(Math.abs(bottleneck.net) / (best.building.production?.colony?.[bottleneck.name] ?? 1)),
          reason: `${bottleneck.name} has negative net (${bottleneck.net.toFixed(2)}/s)`,
        };
      }
    }
    
    // Colony progression
    const tier = getCurrentColonyTier();
    if (tier < 7) {
      return {
        action: 'colony',
        tier: tier + 1,
        reason: `Progress to colony tier ${tier + 1} (current: ${tier})`,
      };
    }
    
    // Ecumenopolis expansion
    const colonies = getColonies();
    const eco = colonies?.t7_colony;
    if (eco) {
      const landState = analyzeResourceState('land', 'surface');
      const targetActive = Math.floor((landState?.value ?? 0) * CFG.targetLandPercent / 100 / (eco.requiresLand ?? 100000));
      const currentActive = eco.active ?? 0;
      
      if (currentActive < targetActive) {
        return {
          action: 'ecumenopolis',
          count: Math.min(10, targetActive - currentActive),
          reason: `Expand Ecumenopolis (${currentActive}/${targetActive} active)`,
        };
      }
    }
    
    return { action: 'optimize', reason: 'Optimization phase' };
  }

  function executePlan(plan) {
    if (!plan) return false;
    
    switch (plan.action) {
      case 'build':
        if (buildStructure(plan.building, plan.count)) {
          state.stats.structuresBuilt += plan.count;
          state.lastAction = `Built ${plan.count}x ${plan.building}`;
          if (CFG.autoEnableBuildings) {
            enableStructure(plan.building);
          }
          return true;
        }
        break;
        
      case 'colony':
        if (buildNextColonyTier()) {
          state.stats.coloniesUpgraded++;
          state.lastAction = `Upgraded to colony tier ${plan.tier}`;
          return true;
        }
        break;
        
      case 'ecumenopolis':
        if (buildStructure('t7_colony', plan.count)) {
          state.stats.structuresBuilt += plan.count;
          state.lastAction = `Built ${plan.count}x Ecumenopolis districts`;
          if (CFG.autoEnableBuildings) {
            enableStructure('t7_colony');
          }
          return true;
        }
        break;
    }
    
    return false;
  }

  function tick() {
    if (!CFG.enabled) return;
    
    const now = Date.now();
    if (now - state.lastTick < CFG.tickMs) return;
    state.lastTick = now;
    
    try {
      // Create plan every 5 ticks
      if (!state.plan || (state.lastTick % (CFG.tickMs * 5) === 0)) {
        state.plan = createBuildPlan();
      }
      
      // Execute plan
      if (state.plan) {
        executePlan(state.plan);
      }
      
      updateHUD();
    } catch (err) {
      log("Tick error:", err);
      state.lastAction = `Error: ${err.message}`;
    }
  }

  // ============ HUD ============
  let hudEl = null;

  function createHUD() {
    if (hudEl) return;

    const css = `
      #growth-hud {
        position: fixed;
        right: 12px;
        top: 120px;
        z-index: 2147483646;
        background: rgba(18, 22, 30, 0.95);
        border: 1px solid rgba(100, 200, 255, 0.3);
        border-radius: 12px;
        padding: 12px;
        color: #e8eefc;
        font: 12px/1.4 system-ui, sans-serif;
        min-width: 340px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }
      #growth-hud .title {
        font-weight: 800;
        margin-bottom: 10px;
        font-size: 14px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      #growth-hud button {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e8eefc;
        padding: 6px 12px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      #growth-hud button:hover { background: rgba(255, 255, 255, 0.15); }
      #growth-hud button.active {
        background: rgba(100, 255, 100, 0.2);
        border-color: rgba(100, 255, 100, 0.4);
      }
      #growth-hud .section {
        margin: 10px 0;
        padding: 8px;
        background: rgba(255, 255, 255, 0.03);
        border-radius: 8px;
      }
      #growth-hud .section-title {
        font-weight: 700;
        margin-bottom: 6px;
        opacity: 0.9;
      }
      #growth-hud .stat {
        display: flex;
        justify-content: space-between;
        margin: 4px 0;
        font-size: 11px;
        opacity: 0.85;
      }
      #growth-hud .plan {
        padding: 8px;
        background: rgba(100, 200, 255, 0.1);
        border: 1px solid rgba(100, 200, 255, 0.3);
        border-radius: 8px;
        font-size: 11px;
      }
      #growth-hud .plan-title {
        font-weight: 700;
        margin-bottom: 4px;
      }
    `;

    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    hudEl = document.createElement("div");
    hudEl.id = "growth-hud";

    hudEl.innerHTML = `
      <div class="title">
        <span>Growth Engine</span>
        <button id="growth-toggle">${CFG.enabled ? 'STOP' : 'START'}</button>
      </div>
      
      <div class="section">
        <div class="section-title">Statistics</div>
        <div class="stat">
          <span>Structures Built:</span>
          <span id="structures-built">0</span>
        </div>
        <div class="stat">
          <span>Colonies Upgraded:</span>
          <span id="colonies-upgraded">0</span>
        </div>
        <div class="stat">
          <span>Colony Tier:</span>
          <span id="colony-tier">-</span>
        </div>
      </div>
      
      <div class="section">
        <div class="section-title">Current Bottleneck</div>
        <div id="bottleneck-info" class="stat">Analyzing...</div>
      </div>
      
      <div id="plan-display" class="plan">
        <div class="plan-title">Current Plan</div>
        <div id="plan-text">No plan yet</div>
      </div>
      
      <div class="section">
        <div class="section-title">Last Action</div>
        <div id="last-action" style="font-size: 11px; opacity: 0.8;">Idle</div>
      </div>
    `;

    document.body.appendChild(hudEl);

    const toggleBtn = hudEl.querySelector("#growth-toggle");
    toggleBtn.classList.toggle("active", CFG.enabled);
    toggleBtn.addEventListener("click", () => {
      CFG.enabled = !CFG.enabled;
      toggleBtn.textContent = CFG.enabled ? 'STOP' : 'START';
      toggleBtn.classList.toggle("active", CFG.enabled);
      state.lastAction = CFG.enabled ? "Started automation" : "Stopped automation";
      updateHUD();
    });
  }

  function updateHUD() {
    if (!hudEl) return;

    // Stats
    const structuresEl = hudEl.querySelector("#structures-built");
    const coloniesEl = hudEl.querySelector("#colonies-upgraded");
    const tierEl = hudEl.querySelector("#colony-tier");
    
    if (structuresEl) structuresEl.textContent = state.stats.structuresBuilt;
    if (coloniesEl) coloniesEl.textContent = state.stats.coloniesUpgraded;
    if (tierEl) tierEl.textContent = getCurrentColonyTier();

    // Bottleneck
    const bottleneck = findBottleneck();
    const bottleneckEl = hudEl.querySelector("#bottleneck-info");
    if (bottleneckEl && bottleneck) {
      bottleneckEl.innerHTML = `
        <span>${bottleneck.name}</span>
        <span>${bottleneck.fillPercent.toFixed(1)}% (net: ${bottleneck.net.toFixed(2)}/s)</span>
      `;
    }

    // Plan
    const planEl = hudEl.querySelector("#plan-text");
    if (planEl && state.plan) {
      planEl.textContent = state.plan.reason || 'No plan';
    }

    // Last action
    const actionEl = hudEl.querySelector("#last-action");
    if (actionEl) actionEl.textContent = state.lastAction || 'Idle';
  }

  // ============ INIT ============
  function init() {
    log("Growth Automation Engine v4.0.0 starting...");
    
    createHUD();
    setInterval(tick, 200);
    
    window.ttGrowthEngine = {
      config: CFG,
      state,
      analyze: analyzeResourceState,
      findBottleneck,
      createPlan: createBuildPlan,
    };

    log("Ready! Click START to begin automation");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
