// ==UserScript==
// @name         TT - WGC Full System Controller
// @namespace    tt-wgc-full
// @version      2.0.0
// @description  Complete WGC automation: equipment buying, facility upgrades, team optimization, and mission control
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
    enabled: true,
    
    // Team management
    minDeployHpRatio: 0.90,
    allowStartWhileResting: false,
    autoAssignTeams: true,
    
    // Equipment purchasing
    autoBuyEquipment: true,
    alienArtifactReserve: 1000,
    equipmentBuyBatch: 10,
    
    // Facility upgrades
    autoUpgradeFacilities: true,
    facilityCandidates: ["library", "shootingRange", "obstacleCourse", "infirmary"],
    
    // Mission selection
    autoSelectDifficulty: true,
    difficultyStrategy: "highest", // "highest", "balanced", "safe"
    
    // Timing
    tickMs: 2000,
    
    // UI
    showHud: true,
    hudMinimized: false,
  };

  const W = window;
  const log = (...args) => console.log("[WGC]", ...args);

  // ============ SAFE ACCESS ============
  function getWGC() {
    try {
      return (typeof warpGateCommand !== "undefined") ? warpGateCommand : W.warpGateCommand || null;
    } catch { return null; }
  }

  function getResources() {
    try {
      return (typeof resources !== "undefined") ? resources : W.resources || null;
    } catch { return null; }
  }

  function getAlienArtifacts() {
    const res = getResources();
    return res?.special?.alienArtifact?.value ?? 0;
  }

  // ============ STATE ============
  const state = {
    lastTick: 0,
    lastAction: "",
    stats: {
      equipmentBought: 0,
      facilitiesUpgraded: 0,
      missionsStarted: 0,
    }
  };

  // ============ UTILITIES ============
  function clamp(x, a, b) {
    const n = Number(x);
    return !Number.isFinite(n) ? a : Math.max(a, Math.min(b, n));
  }

  function getHpRatio(member) {
    if (!member) return 0;
    const hp = member.health ?? member.hp ?? member.currentHealth ?? 0;
    const maxHp = member.maxHealth ?? member.maxHp ?? member.maximumHealth ?? 
                  (member.level ? (100 + (member.level - 1) * 10) : 100);
    return maxHp > 0 ? clamp(hp / maxHp, 0, 1) : 0;
  }

  function teamReady(team) {
    if (!Array.isArray(team) || team.length === 0) return false;
    if (CFG.allowStartWhileResting) return team.every(m => m);
    return team.every(m => m && getHpRatio(m) >= CFG.minDeployHpRatio);
  }

  function getMemberPower(member) {
    if (!member) return 0;
    
    const level = member.level ?? 1;
    const hp = getHpRatio(member);
    
    // Equipment bonuses
    let equipBonus = 0;
    if (member.equipment) {
      Object.values(member.equipment).forEach(item => {
        if (item) equipBonus += (item.level ?? 0) * 10;
      });
    }
    
    return (level * 100 * hp) + equipBonus;
  }

  function getTeamPower(team) {
    if (!Array.isArray(team)) return 0;
    return team.reduce((sum, m) => sum + getMemberPower(m), 0);
  }

  // ============ EQUIPMENT SYSTEM ============
  function buyBestEquipment() {
    const wgc = getWGC();
    if (!wgc || !CFG.autoBuyEquipment) return false;

    const artifacts = getAlienArtifacts();
    if (artifacts < CFG.alienArtifactReserve + 100) return false;

    try {
      // Find all members
      const allMembers = [];
      for (let i = 0; i < 4; i++) {
        const team = wgc.teams?.[i];
        if (Array.isArray(team)) allMembers.push(...team.filter(m => m));
      }

      if (allMembers.length === 0) return false;

      // Find member with worst equipment
      let worstMember = null;
      let worstScore = Infinity;

      allMembers.forEach(member => {
        if (!member) return;
        
        let equipScore = 0;
        const slots = ["weapon", "armor", "accessory"];
        
        slots.forEach(slot => {
          const item = member.equipment?.[slot];
          equipScore += item ? ((item.level ?? 0) * 10) : 0;
        });
        
        if (equipScore < worstScore) {
          worstScore = equipScore;
          worstMember = member;
        }
      });

      if (!worstMember) return false;

      // Find worst slot on worst member
      const slots = ["weapon", "armor", "accessory"];
      let worstSlot = null;
      let worstLevel = Infinity;

      slots.forEach(slot => {
        const item = worstMember.equipment?.[slot];
        const level = item ? (item.level ?? 0) : 0;
        if (level < worstLevel) {
          worstLevel = level;
          worstSlot = slot;
        }
      });

      if (!worstSlot) return false;

      // Try to buy equipment
      if (typeof wgc.buyEquipment === "function") {
        const bought = wgc.buyEquipment(worstMember.id, worstSlot);
        if (bought) {
          state.lastAction = `Bought ${worstSlot} for ${worstMember.name}`;
          state.stats.equipmentBought++;
          return true;
        }
      }

      // Fallback: try finding buy method in shop
      if (wgc.shop && typeof wgc.shop.buyEquipment === "function") {
        const bought = wgc.shop.buyEquipment(worstMember.id, worstSlot);
        if (bought) {
          state.lastAction = `Bought ${worstSlot} for ${worstMember.name}`;
          state.stats.equipmentBought++;
          return true;
        }
      }

    } catch (err) {
      log("Equipment buy error:", err);
    }

    return false;
  }

  // ============ FACILITY SYSTEM ============
  function upgradeFacilities() {
    const wgc = getWGC();
    if (!wgc || !CFG.autoUpgradeFacilities) return false;

    try {
      const facilities = wgc.facilities || {};
      
      // Find upgradeable facility
      for (const name of CFG.facilityCandidates) {
        const facility = facilities[name];
        if (!facility) continue;

        const level = facility.level ?? 0;
        const maxLevel = facility.maxLevel ?? 10;
        
        if (level >= maxLevel) continue;

        // Check if can afford
        const cost = facility.upgradeCost || facility.cost;
        if (!cost) continue;

        const artifacts = getAlienArtifacts();
        const needed = cost.alienArtifact ?? cost.special?.alienArtifact ?? 0;
        
        if (artifacts < needed + CFG.alienArtifactReserve) continue;

        // Try to upgrade
        if (typeof wgc.upgradeFacility === "function") {
          const upgraded = wgc.upgradeFacility(name);
          if (upgraded) {
            state.lastAction = `Upgraded ${name} to level ${level + 1}`;
            state.stats.facilitiesUpgraded++;
            return true;
          }
        }

        // Fallback: direct property manipulation
        if (typeof facility.upgrade === "function") {
          const upgraded = facility.upgrade();
          if (upgraded) {
            state.lastAction = `Upgraded ${name} to level ${level + 1}`;
            state.stats.facilitiesUpgraded++;
            return true;
          }
        }
      }
    } catch (err) {
      log("Facility upgrade error:", err);
    }

    return false;
  }

  // ============ TEAM ASSIGNMENT ============
  function autoAssignMembers() {
    const wgc = getWGC();
    if (!wgc || !CFG.autoAssignTeams) return false;

    try {
      // Get all available members
      const pool = wgc.availableMembers || wgc.members || [];
      if (!Array.isArray(pool) || pool.length === 0) return false;

      // Sort by power
      const sorted = [...pool].sort((a, b) => getMemberPower(b) - getMemberPower(a));

      // Assign to teams (3 per team)
      let assigned = false;
      for (let teamIdx = 0; teamIdx < 4; teamIdx++) {
        const team = wgc.teams?.[teamIdx] || [];
        
        // Skip if team is full
        if (team.filter(m => m).length >= 3) continue;

        // Fill empty slots
        for (let slot = 0; slot < 3; slot++) {
          if (team[slot]) continue;
          
          // Find best unassigned member
          const member = sorted.find(m => {
            if (!m) return false;
            // Check if already assigned
            for (let t = 0; t < 4; t++) {
              const otherTeam = wgc.teams?.[t] || [];
              if (otherTeam.includes(m)) return false;
            }
            return true;
          });

          if (!member) break;

          // Assign member
          if (typeof wgc.assignMember === "function") {
            wgc.assignMember(member.id, teamIdx, slot);
            assigned = true;
          } else if (team[slot] !== member) {
            team[slot] = member;
            assigned = true;
          }
        }
      }

      if (assigned) {
        state.lastAction = "Auto-assigned team members";
      }

      return assigned;
    } catch (err) {
      log("Team assignment error:", err);
    }

    return false;
  }

  // ============ DIFFICULTY SELECTION ============
  function selectBestDifficulty(teamIdx, teamPower) {
    const wgc = getWGC();
    if (!wgc) return null;

    try {
      const op = wgc.operations?.[teamIdx];
      if (!op) return null;

      const difficulties = op.difficulties || [1, 2, 3, 4, 5];
      
      if (CFG.difficultyStrategy === "highest") {
        // Always pick highest available
        return Math.max(...difficulties);
      } else if (CFG.difficultyStrategy === "safe") {
        // Pick difficulty where team power > required power * 1.5
        const safe = difficulties.filter(d => {
          const required = d * 500; // Rough estimate
          return teamPower > required * 1.5;
        });
        return safe.length > 0 ? Math.max(...safe) : Math.min(...difficulties);
      } else {
        // Balanced: pick highest where power > required
        const viable = difficulties.filter(d => {
          const required = d * 500;
          return teamPower > required;
        });
        return viable.length > 0 ? Math.max(...viable) : Math.min(...difficulties);
      }
    } catch (err) {
      log("Difficulty selection error:", err);
    }

    return null;
  }

  // ============ MISSION CONTROL ============
  function manageMissions() {
    const wgc = getWGC();
    if (!wgc || !wgc.enabled) return;

    try {
      for (let teamIdx = 0; teamIdx < 4; teamIdx++) {
        // Check if team slot is unlocked
        if (typeof wgc.isTeamUnlocked === "function" && !wgc.isTeamUnlocked(teamIdx)) {
          continue;
        }

        const team = wgc.teams?.[teamIdx];
        const op = wgc.operations?.[teamIdx];
        
        if (!Array.isArray(team) || !op) continue;
        if (team.some(m => !m)) continue; // Skip incomplete teams
        if (op.active) continue; // Already on mission

        if (!teamReady(team)) continue;

        // Select difficulty
        const teamPower = getTeamPower(team);
        let difficulty = op.difficulty ?? 1;

        if (CFG.autoSelectDifficulty) {
          const selected = selectBestDifficulty(teamIdx, teamPower);
          if (selected !== null) difficulty = selected;
        }

        // Start mission
        if (typeof wgc.startOperation === "function") {
          const started = wgc.startOperation(teamIdx, difficulty);
          if (started) {
            state.lastAction = `Started T${teamIdx + 1} mission (diff ${difficulty})`;
            state.stats.missionsStarted++;
          }
        }
      }
    } catch (err) {
      log("Mission management error:", err);
    }

    // Update UI if exists
    if (typeof updateWGCUI === "function") {
      try { updateWGCUI(); } catch {}
    }
  }

  // ============ MAIN LOOP ============
  function tick() {
    if (!CFG.enabled) return;

    const now = Date.now();
    if (now - state.lastTick < CFG.tickMs) return;
    state.lastTick = now;

    try {
      // Priority order:
      // 1. Auto-assign members (foundation)
      autoAssignMembers();
      
      // 2. Buy equipment (power boost)
      buyBestEquipment();
      
      // 3. Upgrade facilities (long-term investment)
      upgradeFacilities();
      
      // 4. Manage missions (active gameplay)
      manageMissions();

      updateHUD();
    } catch (err) {
      log("Tick error:", err);
    }
  }

  // ============ HUD ============
  let hudEl = null;

  function createHUD() {
    if (!CFG.showHud || hudEl) return;

    const css = `
      #wgc-hud {
        position: fixed;
        right: 12px;
        bottom: 12px;
        z-index: 2147483647;
        background: rgba(18, 22, 30, 0.95);
        border: 1px solid rgba(140, 200, 255, 0.3);
        border-radius: 12px;
        padding: 12px;
        color: #e8eefc;
        font: 12px/1.4 system-ui, sans-serif;
        min-width: 280px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }
      #wgc-hud.minimized { min-width: 0; padding: 8px; }
      #wgc-hud .title {
        font-weight: 800;
        margin-bottom: 8px;
        display: flex;
        justify-content: space-between;
        align-items: center;
      }
      #wgc-hud .stat { 
        display: flex; 
        justify-content: space-between; 
        margin: 4px 0;
        opacity: 0.9;
      }
      #wgc-hud .stat .label { opacity: 0.8; }
      #wgc-hud .action {
        margin-top: 8px;
        padding: 6px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 6px;
        font-size: 11px;
        opacity: 0.85;
      }
      #wgc-hud button {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e8eefc;
        padding: 4px 8px;
        border-radius: 6px;
        cursor: pointer;
        font-size: 11px;
      }
      #wgc-hud button:hover { background: rgba(255, 255, 255, 0.15); }
      #wgc-hud.minimized .content { display: none; }
    `;

    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    hudEl = document.createElement("div");
    hudEl.id = "wgc-hud";
    if (CFG.hudMinimized) hudEl.classList.add("minimized");

    hudEl.innerHTML = `
      <div class="title">
        <span>WGC Controller</span>
        <button id="wgc-min-btn">${CFG.hudMinimized ? "+" : "−"}</button>
      </div>
      <div class="content">
        <div class="stat">
          <span class="label">Equipment:</span>
          <span id="wgc-equip">0</span>
        </div>
        <div class="stat">
          <span class="label">Facilities:</span>
          <span id="wgc-fac">0</span>
        </div>
        <div class="stat">
          <span class="label">Missions:</span>
          <span id="wgc-miss">0</span>
        </div>
        <div class="stat">
          <span class="label">Artifacts:</span>
          <span id="wgc-art">0</span>
        </div>
        <div class="action" id="wgc-action">Initializing...</div>
      </div>
    `;

    document.body.appendChild(hudEl);

    hudEl.querySelector("#wgc-min-btn").addEventListener("click", () => {
      CFG.hudMinimized = !CFG.hudMinimized;
      hudEl.classList.toggle("minimized", CFG.hudMinimized);
      hudEl.querySelector("#wgc-min-btn").textContent = CFG.hudMinimized ? "+" : "−";
    });
  }

  function updateHUD() {
    if (!hudEl) return;

    const equipEl = hudEl.querySelector("#wgc-equip");
    const facEl = hudEl.querySelector("#wgc-fac");
    const missEl = hudEl.querySelector("#wgc-miss");
    const artEl = hudEl.querySelector("#wgc-art");
    const actionEl = hudEl.querySelector("#wgc-action");

    if (equipEl) equipEl.textContent = state.stats.equipmentBought;
    if (facEl) facEl.textContent = state.stats.facilitiesUpgraded;
    if (missEl) missEl.textContent = state.stats.missionsStarted;
    if (artEl) artEl.textContent = Math.floor(getAlienArtifacts());
    if (actionEl) actionEl.textContent = state.lastAction || "Waiting...";
  }

  // ============ INIT ============
  function init() {
    log("WGC Full System Controller v2.0.0 starting...");
    
    createHUD();
    setInterval(tick, 200);
    
    // Export API
    W.ttWgcController = {
      config: CFG,
      state,
      getWGC,
      buyEquipment: buyBestEquipment,
      upgradeFacilities,
      manageMissions,
    };

    log("Ready!");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
