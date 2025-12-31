// ==UserScript==
// @name         TT - WGC Optimiser & Manager
// @namespace    tt-wgc-optimizer
// @version      1.1.0
// @description  Deterministic optimiser/manager for Warp Gate Command (teams, stats, stances, difficulty, facilities, WGT equipment, keep-going tickbox).
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  What this script does (high level)
  - For each complete WGC team:
    - Computes the deterministic best (hazardous biomass stance, artifact stance, difficulty) that maximises expected Alien Artifacts/hour
      with a recall-risk penalty (CFG.riskAversion).
    - Applies the plan ONLY while the team is idle (op.active === false).
    - Ensures the "keep going" tickbox in the Start button is ON (this is op.autoStart) for sustained redeploys.
    - If a better plan is found while the team is active, it will NOT change difficulty mid-op.
      Instead it can (by default) temporarily untick autoStart so the current op finishes, then re-tunes and restarts.

  Spending behaviour
  - Alien Artifacts: buys R&D upgrade wgtEquipment (unless disabled) because it deterministically increases artifact drop chance in WGC.
  - Facilities: when cooldown is ready, upgrades the single facility that increases total expected artifacts/hour across all teams the most.
  - Stats: respec + allocate points using class+facility-weighted ratios, then sets auto-allocation ratios for future levels.

  HP question (why minDeployHpRatio exists)
  - If your idle healing is faster than in-op healing, deploying injured teams is usually worse than resting, even on easier difficulty.
  - The optimiser models this via restTime and recall risk, so you can tune CFG.minDeployHpRatio for your preference.

  Console API
  - window.ttWgcOpt (in page context) exposes helpers: getWGC(), optimiseNow(), clearCache(), CFG, etc.
*/

(() => {
  'use strict';

  // Avoid double-inject
  if (window.__ttWgcOptimiserInjectedV11__) return;
  window.__ttWgcOptimiserInjectedV11__ = true;

  function injectedMain() {
    'use strict';
    if (globalThis.ttWgcOpt && globalThis.ttWgcOpt.__installed) return;

    /********************************************************************
     * SETTINGS
     ********************************************************************/
    const CFG = {
      enabled: true,

      // Core loop cadence
      optimiseEveryMs: 60_000,    // 1 minute
      uiRefreshMs: 1_000,

      // Starting logic
      autoStartIdleTeams: true,
      minDeployHpRatio: 0.65,     // don't start a team below this HP ratio

      // "Keep going once I press Start" tickbox (WGC UI: .wgc-auto-start-checkbox)
      // Backing state is op.autoStart.
      forceKeepGoingTick: true,

      // If an active team would benefit from retuning (new difficulty/stances):
      // - 'finish'  => temporarily untick keep-going (autoStart=false) and let this op finish, then retune+restart.
      // - 'recall'  => recall immediately (fast retune, but interrupts run).
      // - 'never'   => never interfere; only retune when the user stops the team.
      retuneModeWhenActive: 'finish', // 'finish' | 'recall' | 'never'

      // Stats / spending
      manageStats: true,
      autoBuyWgtEquipment: true,
      alienArtifactReserve: 0,

      autoUpgradeFacilityWhenReady: true,
      facilityCandidates: ['library', 'shootingRange', 'obstacleCourse', 'infirmary'],

      // Optimiser bounds/shape
      difficultyMax: 5000,
      riskAversion: 5.0,

      // UI
      showPanel: true,
      showDiagnostics: true,
      panelWidth: 480,
    };

    const LOG = (...a) => { if (CFG.showDiagnostics) console.log('[TT WGC]', ...a); };

    /********************************************************************
     * Lexical access (game uses lexical globals, not always window props)
     ********************************************************************/
    function getLex(name) {
      try {
        // eslint-disable-next-line no-new-func
        return Function(`return (typeof ${name} !== "undefined") ? ${name} : undefined;`)();
      } catch (_) { return undefined; }
    }

    function getWGC() {
      const wgc = getLex('warpGateCommand');
      return (wgc && typeof wgc === 'object') ? wgc : null;
    }

    function getResources() {
      return getLex('resources') || globalThis.resources;
    }

    function getStories() {
      return getLex('WGC_OPERATION_STORIES') || globalThis.WGC_OPERATION_STORIES || null;
    }

    function tryUpdateWgcUI() {
      const fn = getLex('updateWGCUI') || globalThis.updateWGCUI;
      if (typeof fn === 'function') {
        try { fn(); } catch (_) {}
      }
    }

    /********************************************************************
     * WGC constants (mirrors wgc.js)
     ********************************************************************/
    const BASE_EVENTS = [
      { name: 'Individual Team Power Challenge', type: 'individual', skill: 'power', weight: 1, aliases: ['Team Power Challenge'] },
      { name: 'Team Athletics Challenge', type: 'team', skill: 'athletics', weight: 1 },
      { name: 'Team Wits Challenge', type: 'team', skill: 'wit', weight: 1 },
      { name: 'Individual Athletics Challenge', type: 'individual', skill: 'athletics', weight: 1 },
      { name: 'Natural Science challenge', type: 'science', specialty: 'Natural Scientist', escalate: true, weight: 1, artifactMultiplier: 2 },
      { name: 'Social Science challenge', type: 'science', specialty: 'Social Scientist', escalate: true, weight: 1 },
      { name: 'Combat challenge', type: 'combat', weight: 1 }
    ];

    const HAZARD_STANCES = ['Neutral', 'Negotiation', 'Aggressive', 'Recon'];
    const ARTIFACT_STANCES = ['Neutral', 'Careful', 'Rapid Extraction'];

    const baseEventTemplatesByName = (() => {
      const map = Object.create(null);
      for (const evt of BASE_EVENTS) {
        const { aliases, ...template } = evt;
        map[evt.name] = { ...template };
        if (Array.isArray(aliases)) for (const a of aliases) if (!(a in map)) map[a] = { ...template };
      }
      return map;
    })();

    /********************************************************************
     * 4d20 distribution (suffix CDF)
     ********************************************************************/
    const fourD20 = (() => {
      const pmf = new Array(81).fill(0);
      for (let a = 1; a <= 20; a++) for (let b = 1; b <= 20; b++) for (let c = 1; c <= 20; c++) for (let d = 1; d <= 20; d++) pmf[a + b + c + d] += 1;
      const total = Math.pow(20, 4);
      const suffix = new Array(82).fill(0);
      let running = 0;
      for (let s = 80; s >= 0; s--) { running += pmf[s] || 0; suffix[s] = running / total; }
      return { suffix };
    })();

    /********************************************************************
     * Helpers
     ********************************************************************/
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

    function normCdf(z) {
      const t = 1 / (1 + 0.3275911 * Math.abs(z));
      const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
      const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-z * z);
      const sign = z < 0 ? -1 : 1;
      return 0.5 * (1 + sign * erf);
    }

    function prob1d20Success(dcMinusSkill) {
      const needed = Math.ceil(dcMinusSkill);
      if (needed <= 1) return 1;
      if (needed > 20) return 0;
      return (21 - needed) / 20;
    }

    function prob4d20Success(dcMinusSkill) {
      const needed = Math.ceil(dcMinusSkill);
      if (needed <= 4) return 1;
      if (needed > 80) return 0;
      return fourD20.suffix[needed];
    }

    function getFacilityRerollBudget(level) {
      if (level >= 50) return 3;
      if (level >= 25) return 2;
      if (level >= 10) return 1;
      return 0;
    }

    function facilityKeyForEvent(event) {
      if (!event) return null;
      if (event.type === 'combat') return 'shootingRange';
      if (event.type === 'science') return 'library';
      const skill = event.skill || '';
      if (skill === 'power') return 'shootingRange';
      if (skill === 'athletics') return 'obstacleCourse';
      if (skill === 'wit') return 'library';
      return null;
    }

    function stanceDifficultyModifier(event, hazardStance) {
      let mod = 1;
      if (!event) return 1;
      if (hazardStance === 'Negotiation') {
        if (event.name === 'Social Science challenge') mod *= 0.9;
        if (event.type === 'combat') mod *= 1.1;
      } else if (hazardStance === 'Aggressive') {
        if (event.name === 'Social Science challenge') mod *= 1.25;
        if (event.type === 'combat') mod *= 0.85;
      } else if (hazardStance === 'Recon') {
        if (event.type === 'combat') mod *= 0.85;
        if (event.skill === 'athletics') mod *= 1.25;
        if (event.skill === 'wit') mod *= 0.9;
      }
      return mod;
    }

    function getEventDelaySeconds(event, artifactStance) {
      if (event && event.type === 'science' && event.specialty === 'Natural Scientist') {
        if (artifactStance === 'Careful') return 180;
        if (artifactStance === 'Rapid Extraction') return 30;
      }
      return 60;
    }

    function carefulExtraDelay(event, artifactStance) {
      if (event && event.specialty === 'Natural Scientist' && artifactStance === 'Careful') return 120;
      return 0;
    }

    function baseArtifactChance(equipPurchases) {
      return Math.min(0.1 + (equipPurchases || 0) * 0.001, 1);
    }

    function eventArtifactChance(event, equipPurchases, artifactStance) {
      let c = baseArtifactChance(equipPurchases);
      if (artifactStance === 'Rapid Extraction') return Math.max(0, c * 0.25);
      if (artifactStance === 'Careful' && event && event.specialty === 'Natural Scientist') return Math.min(1, c * 2);
      return c;
    }

    /********************************************************************
     * Team skill totals (mirrors resolveEvent)
     ********************************************************************/
    function skillMultipliers(facilities) {
      const shootingRange = facilities.shootingRange || 0;
      const obstacleCourse = facilities.obstacleCourse || 0;
      const library = facilities.library || 0;
      return {
        pMult: 1 + shootingRange * 0.01,
        aMult: 1 + obstacleCourse * 0.01,
        wMult: 1 + library * 0.01
      };
    }

    function applyMult(val, skill, mults) {
      if (skill === 'power') return val * mults.pMult;
      if (skill === 'athletics') return val * mults.aMult;
      if (skill === 'wit') return val * mults.wMult;
      return val;
    }

    function teamSkillTotal(team, eventSkill, mults) {
      return team.reduce((s, m) => {
        if (!m) return s;
        let contrib = applyMult(m[eventSkill], eventSkill, mults);
        if (eventSkill === 'wit' && (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist')) contrib *= 1.5;
        return s + contrib;
      }, 0);
    }

    function combatSkillTotal(team, mults) {
      return team.reduce((s, m) => {
        if (!m) return s;
        const mult = m.classType === 'Soldier' ? 2 : 1;
        return s + applyMult(m.power, 'power', mults) * mult;
      }, 0);
    }

    function pickAthleticsPool(team) {
      let highest = Number.NEGATIVE_INFINITY;
      const pool = [];
      for (const m of team) {
        if (!m) continue;
        const v = m.athletics;
        if (v > highest) { highest = v; pool.length = 0; pool.push(m); }
        else if (v === highest) pool.push(m);
      }
      return pool.length ? pool : team.filter(Boolean);
    }

    /********************************************************************
     * "Keep going" tickbox (Start-button checkbox)
     * UI: input.wgc-auto-start-checkbox[data-team="..."]
     * State: op.autoStart
     ********************************************************************/
    function setKeepGoing(teamIndex, desired) {
      const wgc = getWGC();
      if (!wgc) return false;
      const op = wgc.operations?.[teamIndex];
      if (!op) return false;

      op.autoStart = !!desired;

      // Best-effort UI tick
      try {
        const sel = `input.wgc-auto-start-checkbox[data-team="${teamIndex}"]`;
        const el = document.querySelector(sel);
        if (el && el.checked !== !!desired) {
          el.checked = !!desired;
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
        }
      } catch (_) {}

      return true;
    }

    /********************************************************************
     * Event evaluation (expected value, deterministic)
     ********************************************************************/
    function evalEventOnce({
      team,
      facilities,
      equipPurchases,
      hazardStance,
      artifactStance,
      baseDifficulty,
      nextDiffMod,
      nextArtMod,
      event,
      forceStanceDifficultyModifier,
      combatDifficultyMultiplier,
      isImmediateCombat,
    }) {
      const mults = skillMultipliers(facilities);
      const facilityKey = facilityKeyForEvent(event);
      const facilityLevel = facilityKey ? (facilities[facilityKey] || 0) : 0;
      const hasFailSafe = facilityLevel >= 100;
      const rerollBudget = facilityKey ? getFacilityRerollBudget(facilityLevel) : 0;
      const hasReroll = rerollBudget > 0;

      const stanceMod = (forceStanceDifficultyModifier != null) ? forceStanceDifficultyModifier : stanceDifficultyModifier(event, hazardStance);
      const difficultyForCheck = baseDifficulty * nextDiffMod;
      const scaledDifficulty = difficultyForCheck * stanceMod;

      let dc = 0;
      let skillTotal = 0;

      let individualSelection = null;
      let damageEach = 0;
      let damageOnFail = 0;

      if (event.type === 'team') {
        skillTotal = teamSkillTotal(team, event.skill, mults);
        dc = Math.max(0, (40 + difficultyForCheck * 4) * stanceMod);
        damageEach = 2 * scaledDifficulty;
        if (event.skill === 'wit') damageEach *= 0.5;
        damageEach = Math.max(0, damageEach);
      } else if (event.type === 'combat') {
        skillTotal = combatSkillTotal(team, mults);
        const cm = combatDifficultyMultiplier || 1;
        dc = Math.max(0, (40 * cm + 4 * difficultyForCheck) * stanceMod);
        damageEach = Math.max(0, 5 * scaledDifficulty);
      } else if (event.type === 'science') {
        const leader = team[0];
        let roller = team.find(m => m && m.classType === event.specialty);
        if (!roller) roller = leader;
        const leaderIsRoller = roller === leader;

        const baseSkill = applyMult(roller ? roller.wit : 0, 'wit', mults);
        const leaderBonus = leaderIsRoller ? 0 : (leader ? applyMult(leader.wit, 'wit', mults) / 2 : 0);
        skillTotal = baseSkill + leaderBonus;

        dc = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
      } else if (event.type === 'individual') {
        const leader = team[0];
        let pool = team.filter(Boolean);
        if (event.skill === 'athletics') pool = pickAthleticsPool(team);

        const pSelect = 1 / pool.length;
        const entries = [];

        for (const m of pool) {
          const baseSkill = applyMult(m[event.skill], event.skill, mults);
          const leaderBonus = leader ? applyMult(leader[event.skill], event.skill, mults) / 2 : 0;
          const st = baseSkill + leaderBonus;

          const dcLocal = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
          const p0 = prob1d20Success(dcLocal - st);

          let pInitSuccess = p0;
          if (hasFailSafe) pInitSuccess = 1;
          else if (hasReroll) pInitSuccess = 1 - Math.pow(1 - p0, 2);
          const pInitFail = 1 - pInitSuccess;

          const needed = Math.ceil(dcLocal - st);
          const twentyIsInitSuccess = needed <= 20;
          const pFinalRoll20 = (twentyIsInitSuccess ? (1 / 20) : 0) + ((1 - p0) * (hasReroll ? (1 / 20) : 0));

          entries.push({ m, pSelect, p0, pInitSuccess, pInitFail, pFinalRoll20, dcLocal, skillTotal: st });
        }

        individualSelection = { entries };

        let dmg = 5 * scaledDifficulty;
        if (event.skill === 'power') dmg *= 2;
        if (event.skill === 'wit') dmg *= 0.5;
        damageOnFail = Math.max(0, dmg);
      } else {
        dc = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
        skillTotal = 0;
      }

      let p0 = 0;
      if (event.type === 'team' || event.type === 'combat') p0 = prob4d20Success(dc - skillTotal);
      else if (event.type === 'science') p0 = prob1d20Success(dc - skillTotal);

      let pInitSuccess = 0;
      let pInitFail = 0;

      if (event.type !== 'individual') {
        if (hasFailSafe) pInitSuccess = 1;
        else if (hasReroll) pInitSuccess = 1 - Math.pow(1 - p0, 2);
        else pInitSuccess = p0;
        pInitFail = 1 - pInitSuccess;
      }

      const chance = eventArtifactChance(event, equipPurchases, artifactStance);
      const rewardBase = 1 + baseDifficulty * 0.1; // uses base difficulty (wgc.js behaviour)
      const eventMult = event.artifactMultiplier || (event.specialty === 'Natural Scientist' ? 2 : 1);
      const reward = rewardBase * eventMult * nextArtMod;

      let expectedArtifacts = 0;

      if (event.type === 'individual') {
        let pFinal20 = 0;
        let pInitSuccessNonCritW = 0;
        for (const e of individualSelection.entries) {
          pFinal20 += e.pSelect * e.pFinalRoll20;
          const needed = Math.ceil(e.dcLocal - e.skillTotal);
          const twentyIsInitSuccess = needed <= 20;
          const pInitSuccessNonCrit = e.pInitSuccess - (twentyIsInitSuccess ? e.pFinalRoll20 : 0);
          pInitSuccessNonCritW += e.pSelect * pInitSuccessNonCrit;
        }
        expectedArtifacts = reward * (pFinal20 + pInitSuccessNonCritW * chance);
      } else {
        expectedArtifacts = reward * (pInitSuccess * chance);
      }

      let expectedExtraDelay = 0;
      if (event.type === 'team' && event.skill === 'athletics') expectedExtraDelay += pInitFail * 120;

      if (hazardStance === 'Recon') {
        if (event.type === 'individual') {
          let pFail = 0;
          for (const e of individualSelection.entries) pFail += e.pSelect * e.pInitFail;
          expectedExtraDelay += pFail * 60;
        } else {
          expectedExtraDelay += pInitFail * 60;
        }
      }

      expectedExtraDelay += carefulExtraDelay(event, artifactStance);
      const baseDelay = isImmediateCombat ? 0 : getEventDelaySeconds(event, artifactStance);

      const members = team.filter(Boolean);
      const dmgMean = members.map(() => 0);
      const dmgVar = members.map(() => 0);

      if (event.type === 'team' || event.type === 'combat') {
        if (damageEach > 0) {
          for (let i = 0; i < members.length; i++) {
            const p = pInitFail;
            dmgMean[i] += p * damageEach;
            dmgVar[i] += p * (1 - p) * (damageEach * damageEach);
          }
        }
      } else if (event.type === 'individual') {
        if (damageOnFail > 0) {
          for (const entry of individualSelection.entries) {
            const idx = members.indexOf(entry.m);
            if (idx < 0) continue;
            const p = entry.pSelect * entry.pInitFail;
            dmgMean[idx] += p * damageOnFail;
            dmgVar[idx] += p * (1 - p) * (damageOnFail * damageOnFail);
          }
        }
      }

      let trans;
      if (event.type === 'team' && event.skill === 'athletics') {
        trans = [
          { p: pInitSuccess, nextDiffMod: 0.75, nextArtMod: 1 },
          { p: pInitFail, nextDiffMod: 1, nextArtMod: 1 },
        ];
      } else if (event.type === 'team' && event.skill === 'wit') {
        trans = [
          { p: pInitSuccess, nextDiffMod: 1, nextArtMod: 2 },
          { p: pInitFail, nextDiffMod: 1, nextArtMod: 0.5 },
        ];
      } else {
        trans = [{ p: 1, nextDiffMod: 1, nextArtMod: 1 }];
      }

      return {
        expectedArtifacts,
        baseDelay,
        expectedExtraDelay,
        dmgMean,
        dmgVar,
        trans,
        pInitSuccessNonIndividual: (event.type === 'individual') ? null : pInitSuccess,
      };
    }

    /********************************************************************
     * Story evaluation (DP over transitions + inserted combat quirks)
     ********************************************************************/
    function buildStoryEvents(story, hazardStance) {
      const raw = story && Array.isArray(story.events) ? story.events.slice(0, 10) : [];
      const out = [];
      for (const se of raw) {
        const template = baseEventTemplatesByName[se.name] || null;
        const ev = template ? { ...template } : { name: se.name, type: se.type, skill: se.skill, specialty: se.specialty, escalate: !!se.escalate };
        ev._stanceMod = stanceDifficultyModifier(ev, hazardStance);
        out.push(ev);
      }
      return out;
    }

    const storyCache = new Map(); // hazardStance -> eventLists
    function getStoryEventLists(hazardStance) {
      if (storyCache.has(hazardStance)) return storyCache.get(hazardStance);
      const stories = getStories();
      if (!Array.isArray(stories) || !stories.length) return null;
      const lists = stories.map(s => buildStoryEvents(s, hazardStance));
      storyCache.set(hazardStance, lists);
      return lists;
    }

    function evaluateStory({ storyEvents, team, facilities, equipPurchases, hazardStance, artifactStance, baseDifficulty }) {
      // State key: baseIndex|phase|nextDiffMod|nextArtMod
      let nodes = new Map();
      const key = (bi, ph, d, a) => `${bi}|${ph}|${d}|${a}`;
      const add = (map, bi, ph, d, a, p, timeW, lastW) => {
        if (p <= 0) return;
        const k = key(bi, ph, d, a);
        const cur = map.get(k);
        if (!cur) map.set(k, { p, timeW, lastW });
        else { cur.p += p; cur.timeW += timeW; cur.lastW += lastW; }
      };

      add(nodes, 0, 0, 1, 1, 1, 60, 0);

      let artW = 0;
      const members = team.filter(Boolean);
      const dmgMeanW = new Array(members.length).fill(0);
      const dmgVarW = new Array(members.length).fill(0);
      let lastTimeW = 0;
      let endP = 0;

      for (let iter = 0; iter < 1000; iter++) {
        if (nodes.size === 0) break;
        const nextNodes = new Map();

        for (const [k, node] of nodes.entries()) {
          const [biS, phS, dS, aS] = k.split('|');
          const bi = parseInt(biS, 10);
          const ph = parseInt(phS, 10);
          const nextDiffMod = Number(dS);
          const nextArtMod = Number(aS);

          if (bi >= 10 && ph === 0) {
            endP += node.p;
            lastTimeW += node.lastW;
            continue;
          }

          const curTime = node.timeW / node.p;

          if (ph === 0) {
            const event = storyEvents[bi];
            if (!event) {
              endP += node.p;
              lastTimeW += node.lastW;
              continue;
            }

            const evRes = evalEventOnce({
              team, facilities, equipPurchases, hazardStance, artifactStance,
              baseDifficulty, nextDiffMod, nextArtMod,
              event, forceStanceDifficultyModifier: event._stanceMod,
              combatDifficultyMultiplier: 1, isImmediateCombat: false,
            });

            artW += node.p * evRes.expectedArtifacts;
            for (let i = 0; i < members.length; i++) { dmgMeanW[i] += node.p * evRes.dmgMean[i]; dmgVarW[i] += node.p * evRes.dmgVar[i]; }

            const inc = evRes.baseDelay + evRes.expectedExtraDelay;
            const baseNewTime = curTime + inc;

            const isSocialScience = (event.type === 'science' && event.specialty === 'Social Scientist');
            const isNaturalEscalate = (event.type === 'science' && event.specialty === 'Natural Scientist' && event.escalate);

            for (const tr of evRes.trans) {
              if (tr.p <= 0) continue;
              const pBranch = node.p * tr.p;
              const newTimeW = pBranch * baseNewTime;
              const newLastW = pBranch * curTime;

              if (isSocialScience) {
                // In wgc.js, Social Science failure inserts a queued combat at 1.25 difficulty multiplier,
                // and (quirk) stanceDifficultyModifier is not applied to that inserted combat.
                const pSucc = evRes.pInitSuccessNonIndividual != null ? evRes.pInitSuccessNonIndividual : 0;
                const pFail = 1 - pSucc;

                const pToCombat = pBranch * pFail;
                const pToNext = pBranch * (1 - pFail);

                if (pToCombat > 0) add(nextNodes, bi, 1, 1, 1, pToCombat, (pToCombat / pBranch) * newTimeW, (pToCombat / pBranch) * newLastW);
                if (pToNext > 0) add(nextNodes, bi + 1, 0, 1, 1, pToNext, (pToNext / pBranch) * newTimeW, (pToNext / pBranch) * newLastW);
              } else if (isNaturalEscalate) {
                // Natural Science failure triggers immediate combat (no base delay for that combat)
                const pSucc = evRes.pInitSuccessNonIndividual != null ? evRes.pInitSuccessNonIndividual : 0;
                const pFail = 1 - pSucc;

                const combatEv = { name: 'Combat challenge', type: 'combat' };
                const combatRes = evalEventOnce({
                  team, facilities, equipPurchases, hazardStance, artifactStance,
                  baseDifficulty, nextDiffMod: 1, nextArtMod: 1,
                  event: combatEv,
                  forceStanceDifficultyModifier: stanceDifficultyModifier(combatEv, hazardStance),
                  combatDifficultyMultiplier: 1,
                  isImmediateCombat: true,
                });

                artW += pBranch * pFail * combatRes.expectedArtifacts;
                for (let i = 0; i < members.length; i++) { dmgMeanW[i] += pBranch * pFail * combatRes.dmgMean[i]; dmgVarW[i] += pBranch * pFail * combatRes.dmgVar[i]; }

                const extraTimeFromCombat = pFail * combatRes.expectedExtraDelay;
                add(nextNodes, bi + 1, 0, 1, 1, pBranch, pBranch * (baseNewTime + extraTimeFromCombat), newLastW);
              } else {
                add(nextNodes, bi + 1, 0, tr.nextDiffMod, tr.nextArtMod, pBranch, newTimeW, newLastW);
              }
            }
          } else {
            // Inserted combat after Social Science failure (queued => base delay applies)
            const combatEv = { name: 'Combat challenge', type: 'combat' };
            const evRes = evalEventOnce({
              team, facilities, equipPurchases, hazardStance, artifactStance,
              baseDifficulty, nextDiffMod: 1, nextArtMod: 1,
              event: combatEv,
              forceStanceDifficultyModifier: 1,
              combatDifficultyMultiplier: 1.25,
              isImmediateCombat: false,
            });

            artW += node.p * evRes.expectedArtifacts;
            for (let i = 0; i < members.length; i++) { dmgMeanW[i] += node.p * evRes.dmgMean[i]; dmgVarW[i] += node.p * evRes.dmgVar[i]; }

            const inc = evRes.baseDelay + evRes.expectedExtraDelay;
            const newTime = curTime + inc;

            add(nextNodes, bi + 1, 0, 1, 1, node.p, node.p * newTime, node.p * curTime);
          }
        }

        nodes = nextNodes;
      }

      const denom = endP || 1;
      return {
        expectedArtifacts: artW / denom,
        expectedLastTime: (lastTimeW / denom) || 600,
        meanDamage: dmgMeanW.map(v => v / denom),
        varDamage: dmgVarW.map(v => v / denom),
        members: team.filter(Boolean),
      };
    }

    function evaluatePlan(team, facilities, equipPurchases, hazardStance, artifactStance, difficulty) {
      const storyEventLists = getStoryEventLists(hazardStance);
      if (!storyEventLists || !storyEventLists.length) return null;

      let art = 0;
      let lastTime = 0;

      const members = team.filter(Boolean);
      const dmgMean = new Array(members.length).fill(0);
      const dmgVar = new Array(members.length).fill(0);

      for (const storyEvents of storyEventLists) {
        const r = evaluateStory({ storyEvents, team, facilities, equipPurchases, hazardStance, artifactStance, baseDifficulty: difficulty });
        art += r.expectedArtifacts;
        lastTime += r.expectedLastTime;
        for (let i = 0; i < members.length; i++) { dmgMean[i] += r.meanDamage[i]; dmgVar[i] += r.varDamage[i]; }
      }

      const n = storyEventLists.length;
      const expArtifactsPerOp = art / n;
      const expLastTime = lastTime / n;
      const duration = Math.max(600, expLastTime);

      // Recall probability approx (independent normal approx)
      let recallProb = 0;
      if (members.length) {
        let survive = 1;
        for (let i = 0; i < members.length; i++) {
          const mu = dmgMean[i] / n;
          const va = dmgVar[i] / n;
          const sigma = Math.sqrt(Math.max(va, 1e-9));
          const hp = members[i].maxHealth || (100 + (members[i].level - 1) * 10);
          const z = (hp - mu) / sigma;
          const pKill = 1 - normCdf(z);
          survive *= (1 - clamp(pKill, 0, 1));
        }
        recallProb = clamp(1 - survive, 0, 1);
      }

      // Healing/downtime model (approx — tune by changing minDeployHpRatio/riskAversion)
      const healMult = 1 + (facilities.infirmary || 0) * 0.01;
      const activeHeal = (duration / 60) * 1 * healMult;   // ~1 HP/min during operation (model)
      const idleHealPerSec = (50 / 60) * healMult;         // ~50 HP/min while resting (model)

      let percent = 0;
      const inf = facilities.infirmary || 0;
      if (inf >= 100) percent = 0.2;
      else if (inf >= 50) percent = 0.15;
      else if (inf >= 25) percent = 0.1;
      else if (inf >= 10) percent = 0.05;

      let worstDeficit = 0;
      let approxMaxHp = 100;
      for (let i = 0; i < members.length; i++) {
        const hp = members[i].maxHealth || (100 + (members[i].level - 1) * 10);
        approxMaxHp = Math.max(approxMaxHp, hp);
        const mu = dmgMean[i] / n;
        const deficit = Math.max(0, mu - activeHeal);
        worstDeficit = Math.max(worstDeficit, deficit);
      }
      worstDeficit = Math.max(0, worstDeficit - (percent * approxMaxHp));
      const restTime = idleHealPerSec > 0 ? (worstDeficit / idleHealPerSec) : 0;

      const safeArtifacts = expArtifactsPerOp * (1 - recallProb);
      const cycleTime = duration + restTime;
      const artifactsPerHour = cycleTime > 0 ? (safeArtifacts / cycleTime) * 3600 : 0;
      const score = artifactsPerHour * Math.exp(-CFG.riskAversion * recallProb);

      return { score, artifactsPerHour, recallProb, expArtifactsPerOp, duration, restTime };
    }

    /********************************************************************
     * Difficulty + stance optimisation (deterministic search)
     ********************************************************************/
    function optimiseForTeam(team, facilities, equipPurchases, currentDifficulty) {
      const stories = getStories();
      if (!Array.isArray(stories) || !stories.length) return null;

      let best = null;

      for (const hz of HAZARD_STANCES) {
        for (const ar of ARTIFACT_STANCES) {
          let d = Math.max(0, Math.floor(Number.isFinite(currentDifficulty) ? currentDifficulty : 0));
          d = Math.min(d, CFG.difficultyMax);
          let step = Math.max(5, Math.floor((d + 50) / 10));

          const seen = new Map();
          const evalD = (x) => {
            const k = `${hz}|${ar}|${x}`;
            if (seen.has(k)) return seen.get(k);
            const r = evaluatePlan(team, facilities, equipPurchases, hz, ar, x);
            seen.set(k, r);
            return r;
          };

          let cur = evalD(d);
          if (!cur) continue;

          for (let iter = 0; iter < 40; iter++) {
            const upD = Math.min(CFG.difficultyMax, d + step);
            const dnD = Math.max(0, d - step);
            const up = evalD(upD);
            const dn = evalD(dnD);

            const bestLocal = [{ d, r: cur }, { d: upD, r: up }, { d: dnD, r: dn }]
              .filter(x => x.r)
              .sort((a, b) => b.r.score - a.r.score)[0];

            if (bestLocal.d === d) {
              if (step <= 1) break;
              step = Math.max(1, Math.floor(step / 2));
            } else {
              d = clamp(bestLocal.d, 0, CFG.difficultyMax);
              cur = bestLocal.r;
            }
          }

          if (!best || cur.score > best.r.score) best = { hazardStance: hz, artifactStance: ar, difficulty: d, r: cur };
        }
      }

      return best;
    }

    /********************************************************************
     * Stat allocation (deterministic)
     ********************************************************************/
    function allocationFromWeights(points, wP, wA, wW) {
      const sum = wP + wA + wW;
      if (sum <= 0 || points <= 0) return { power: 0, athletics: 0, wit: 0 };

      const raw = [
        { k: 'power', v: points * (wP / sum) },
        { k: 'athletics', v: points * (wA / sum) },
        { k: 'wit', v: points * (wW / sum) },
      ];
      const base = { power: 0, athletics: 0, wit: 0 };
      let used = 0;

      for (const r of raw) {
        const f = Math.floor(r.v);
        base[r.k] = f;
        used += f;
        r.frac = r.v - f;
      }
      let rem = points - used;
      raw.sort((a, b) => b.frac - a.frac);
      for (let i = 0; i < raw.length && rem > 0; i++) { base[raw[i].k] += 1; rem -= 1; }
      return base;
    }

    function applyOptimisedStats(team, facilities) {
      const mults = skillMultipliers(facilities);
      for (const m of team) {
        if (!m) continue;
        if (typeof m.respec !== 'function' || typeof m.getPointsToAllocate !== 'function') continue;

        m.respec();
        const pts = m.getPointsToAllocate();
        if (pts <= 0) continue;

        let wP = 1, wA = 1, wW = 1;
        if (m.classType === 'Soldier') { wP = 7 * mults.pMult; wA = 2 * mults.aMult; wW = 1 * mults.wMult; }
        else if (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist') { wP = 1 * mults.pMult; wA = 2 * mults.aMult; wW = 8 * mults.wMult; }
        else if (m.classType === 'Team Leader') { wP = 3 * mults.pMult; wA = 3 * mults.aMult; wW = 4 * mults.wMult; }

        const alloc = allocationFromWeights(pts, wP, wA, wW);
        if (typeof m.allocatePoints === 'function') m.allocatePoints(alloc);

        if (typeof m.applyAutoSettings === 'function') {
          m.applyAutoSettings(true, {
            enabled: true,
            power: Math.max(0, Math.floor(wP)),
            athletics: Math.max(0, Math.floor(wA)),
            wit: Math.max(0, Math.floor(wW)),
          });
        }
      }
    }

    /********************************************************************
     * Spending: R&D + facilities
     ********************************************************************/
    function tryAutoBuyWgtEquipment() {
      const wgc = getWGC();
      if (!wgc || !CFG.autoBuyWgtEquipment) return;

      const resources = getResources();
      const art = resources?.special?.alienArtifact;
      if (!art || typeof art.value !== 'number') return;

      const up = wgc.rdUpgrades?.wgtEquipment;
      if (!up) return;

      while (up.purchases < (up.max || 900)) {
        const cost = (typeof wgc.getUpgradeCost === 'function') ? wgc.getUpgradeCost('wgtEquipment') : (up.purchases + 1);
        if (art.value - cost < CFG.alienArtifactReserve) break;
        const ok = wgc.purchaseUpgrade && wgc.purchaseUpgrade('wgtEquipment');
        if (!ok) break;
      }
    }

    function tryAutoUpgradeFacility() {
      const wgc = getWGC();
      if (!wgc || !CFG.autoUpgradeFacilityWhenReady) return;
      if ((wgc.facilityCooldown || 0) > 0) return;

      const candidates = CFG.facilityCandidates
        .filter(k => wgc.facilities && typeof wgc.facilities[k] === 'number' && wgc.facilities[k] < 100);

      if (!candidates.length) return;

      const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;

      const teams = [];
      for (let ti = 0; ti < 4; ti++) {
        if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
        const t = wgc.teams?.[ti];
        if (!Array.isArray(t) || t.some(x => !x)) continue;
        teams.push({ team: t, currentDiff: wgc.operations?.[ti]?.difficulty || 0 });
      }
      if (!teams.length) return;

      const baseFacilities = { ...wgc.facilities };

      const scoreWithFacilities = (fac) => {
        let sum = 0;
        for (const { team, currentDiff } of teams) {
          const plan = optimiseForTeam(team, fac, equip, currentDiff);
          if (plan) sum += plan.r.artifactsPerHour;
        }
        return sum;
      };

      const baseScore = scoreWithFacilities(baseFacilities);
      let best = { key: null, score: baseScore };

      for (const k of candidates) {
        const fac = { ...baseFacilities, [k]: baseFacilities[k] + 1 };
        const sc = scoreWithFacilities(fac);
        if (sc > best.score + 1e-9) best = { key: k, score: sc };
      }

      if (best.key && typeof wgc.upgradeFacility === 'function') wgc.upgradeFacility(best.key);
    }

    /********************************************************************
     * Plan cache + signatures (so we don't recompute unless state changes)
     ********************************************************************/
    const planCache = new Map(); // teamIndex -> { sig, plan }

    function teamSignature(team, facilities, equip) {
      const members = team.map(m => [m.classType, m.level, m.power, m.athletics, m.wit].join(':')).join('|');
      const fac = ['infirmary','barracks','shootingRange','obstacleCourse','library'].map(k => `${k}=${facilities[k]||0}`).join(',');
      return `${members}||${fac}||equip=${equip}`;
    }

    function computePlan(teamIndex) {
      const wgc = getWGC();
      if (!wgc) return null;

      const team = wgc.teams?.[teamIndex];
      if (!Array.isArray(team) || team.some(m => !m)) return null;

      const facilities = { ...(wgc.facilities || {}) };
      const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;
      const curDiff = wgc.operations?.[teamIndex]?.difficulty || 0;

      const sig = teamSignature(team, facilities, equip);
      const cached = planCache.get(teamIndex);
      if (cached && cached.sig === sig) return cached.plan;

      const best = optimiseForTeam(team, facilities, equip, curDiff);
      if (!best) return null;

      const plan = {
        hazardousBiomassStance: best.hazardStance,
        artifactStance: best.artifactStance,
        difficulty: best.difficulty,
        metrics: best.r,
      };

      planCache.set(teamIndex, { sig, plan });
      return plan;
    }

    /********************************************************************
     * Apply plan safely (never mid-op)
     ********************************************************************/
    const pendingRetune = new Map(); // teamIndex -> plan we want to apply when idle

    function planDiffersFromCurrent(teamIndex, plan) {
      const wgc = getWGC();
      if (!wgc || !plan) return false;
      const op = wgc.operations?.[teamIndex];
      if (!op) return false;

      const stanceObj = wgc.stances?.[teamIndex] || { hazardousBiomass: 'Neutral', artifact: 'Neutral' };
      const curHaz = stanceObj.hazardousBiomass || 'Neutral';
      const curArt = stanceObj.artifact || 'Neutral';
      const curDiff = Number(op.difficulty || 0);

      if (curHaz !== plan.hazardousBiomassStance) return true;
      if (curArt !== plan.artifactStance) return true;
      if (Math.abs(curDiff - plan.difficulty) >= 1) return true;
      return false;
    }

    function applyPlanIfIdle(teamIndex, plan) {
      const wgc = getWGC();
      if (!wgc || !plan) return false;
      const op = wgc.operations?.[teamIndex];
      if (!op || op.active) return false;

      // set stances (wgc.js API)
      if (typeof wgc.setStance === 'function') wgc.setStance(teamIndex, plan.hazardousBiomassStance);
      if (typeof wgc.setArtifactStance === 'function') wgc.setArtifactStance(teamIndex, plan.artifactStance);

      // set difficulty
      op.difficulty = plan.difficulty;

      // ensure keep-going tickbox
      if (CFG.forceKeepGoingTick) setKeepGoing(teamIndex, true);

      tryUpdateWgcUI();
      return true;
    }

    function teamReady(team) {
      return team.every(m => m && m.maxHealth > 0 && (m.health / m.maxHealth) >= CFG.minDeployHpRatio);
    }

    /********************************************************************
     * Main loop
     ********************************************************************/
    function optimiseTickOnce() {
      if (!CFG.enabled) return;

      const wgc = getWGC();
      if (!wgc || !wgc.enabled) return;

      // Global spending first (affects optimisation)
      if (CFG.autoBuyWgtEquipment) tryAutoBuyWgtEquipment();
      if (CFG.autoUpgradeFacilityWhenReady) tryAutoUpgradeFacility();

      for (let ti = 0; ti < 4; ti++) {
        if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;

        const team = wgc.teams?.[ti];
        if (!Array.isArray(team) || team.some(m => !m)) continue;

        const op = wgc.operations?.[ti];
        if (!op) continue;

        // Keep-going tickbox behaviour:
        // - If idle, force it on (unless user disables CFG.forceKeepGoingTick)
        // - If active, only change it if we are intentionally stopping after finish (retuneMode 'finish')
        if (!op.active && CFG.forceKeepGoingTick) setKeepGoing(ti, true);

        // Optional stats management: only when idle (so we don't mutate mid-op)
        if (!op.active && CFG.manageStats) {
          const facilities = { ...(wgc.facilities || {}) };
          applyOptimisedStats(team, facilities);
        }

        // If there is a pending retune and team is idle now, apply and restart
        if (!op.active && pendingRetune.has(ti)) {
          const plan = pendingRetune.get(ti);
          pendingRetune.delete(ti);
          applyPlanIfIdle(ti, plan);

          if (CFG.autoStartIdleTeams && teamReady(team) && typeof wgc.startOperation === 'function') {
            wgc.startOperation(ti, plan.difficulty);
            // ensure keep-going ON after pressing start
            if (CFG.forceKeepGoingTick) setKeepGoing(ti, true);
            tryUpdateWgcUI();
          }
          continue;
        }

        // Compute plan (cached unless team/facilities/equip changed)
        const plan = computePlan(ti);
        if (!plan) continue;

        // ACTIVE team: do NOT change difficulty/stances mid-op.
        if (op.active) {
          // If plan differs, decide what to do
          if (planDiffersFromCurrent(ti, plan)) {
            if (CFG.retuneModeWhenActive === 'finish') {
              // Stop after this op finishes by unticking keep-going (autoStart=false)
              setKeepGoing(ti, false);
              pendingRetune.set(ti, plan);
            } else if (CFG.retuneModeWhenActive === 'recall') {
              if (typeof wgc.recallTeam === 'function') {
                wgc.recallTeam(ti);
                // now idle: apply plan and restart
                applyPlanIfIdle(ti, plan);
                if (CFG.forceKeepGoingTick) setKeepGoing(ti, true);
                if (CFG.autoStartIdleTeams && teamReady(team) && typeof wgc.startOperation === 'function') {
                  wgc.startOperation(ti, plan.difficulty);
                  if (CFG.forceKeepGoingTick) setKeepGoing(ti, true);
                }
                tryUpdateWgcUI();
              }
            } else {
              // 'never' => do nothing
            }
          }
          continue;
        }

        // IDLE team: apply plan
        applyPlanIfIdle(ti, plan);

        // Auto-start if allowed + HP ok
        if (CFG.autoStartIdleTeams && teamReady(team) && typeof wgc.startOperation === 'function') {
          wgc.startOperation(ti, plan.difficulty);
          if (CFG.forceKeepGoingTick) setKeepGoing(ti, true);
          tryUpdateWgcUI();
        }
      }
    }

    /********************************************************************
     * UI (optional, draggable)
     ********************************************************************/
    const LS_POS_KEY = 'ttWgcOpt.panelPos.v11';
    let panel = null;
    let lastRunAt = 0;

    function loadPos() {
      try { const raw = localStorage.getItem(LS_POS_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; }
    }
    function savePos(left, top) {
      try { localStorage.setItem(LS_POS_KEY, JSON.stringify({ left, top })); } catch (_) {}
    }
    function clampToViewport(left, top, rect) {
      const w = rect?.width || CFG.panelWidth;
      const h = rect?.height || 200;
      const pad = 8;
      const maxL = Math.max(pad, window.innerWidth - w - pad);
      const maxT = Math.max(pad, window.innerHeight - h - pad);
      return { left: clamp(left, pad, maxL), top: clamp(top, pad, maxT) };
    }

    const btnCss = (bg, bd) => `all:unset;cursor:pointer;padding:6px 9px;border-radius:10px;background:${bg};border:1px solid ${bd};`;

    function fmt(x, d = 1) { return Number.isFinite(x) ? x.toFixed(d) : '—'; }

    function refreshPanel() {
      if (!panel) return;
      const wgc = getWGC();
      const res = getResources();
      const art = res?.special?.alienArtifact?.value;
      const equip = wgc?.rdUpgrades?.wgtEquipment?.purchases || 0;
      const cd = wgc?.facilityCooldown || 0;
      const stories = getStories();

      const status = panel.querySelector('#tt-wgc-status');
      const teamsBox = panel.querySelector('#tt-wgc-teams');
      const diag = panel.querySelector('#tt-wgc-diag');

      if (!wgc) {
        status.innerHTML = `<div>Waiting for <b>warpGateCommand</b>…</div>`;
        teamsBox.innerHTML = '';
      } else if (!wgc.enabled) {
        status.innerHTML = `<div>WGC exists but is <b>disabled</b>. Open the WGC tab.</div>`;
        teamsBox.innerHTML = '';
      } else {
        status.innerHTML = `
          <div>Alien Artifacts: <b>${Number.isFinite(art) ? fmt(art, 0) : '—'}</b> | wgtEquipment: <b>${equip}</b> | Facility CD: <b>${fmt(cd, 0)}s</b></div>
          <div style="opacity:0.85;">Auto start idle: <b>${CFG.autoStartIdleTeams ? 'ON' : 'OFF'}</b> | Keep going tick: <b>${CFG.forceKeepGoingTick ? 'ON' : 'OFF'}</b> | Retune while active: <b>${CFG.retuneModeWhenActive}</b></div>
        `;

        teamsBox.innerHTML = '';
        for (let ti = 0; ti < 4; ti++) {
          if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
          const team = wgc.teams?.[ti];
          if (!Array.isArray(team)) continue;
          const op = wgc.operations?.[ti];
          const stanceObj = wgc.stances?.[ti] || { hazardousBiomass: 'Neutral', artifact: 'Neutral' };

          const cached = planCache.get(ti)?.plan || null;

          const fullTeam = team.every(m => m);
          const ready = fullTeam && teamReady(team.filter(Boolean));
          const active = !!op?.active;

          const row = document.createElement('div');
          row.style.cssText = `padding:8px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);`;

          row.innerHTML = `
            <div style="display:flex;gap:8px;align-items:center;">
              <div style="font-weight:800;flex:1;">${wgc.teamNames?.[ti] || `Team ${ti + 1}`}</div>
              <div style="opacity:0.9;">${active ? '🟩 active' : (ready ? '🟦 ready' : '⬛ resting')}</div>
            </div>
            <div style="margin-top:6px;opacity:0.9;">
              Current: <b>${stanceObj.hazardousBiomass}</b> / <b>${stanceObj.artifact}</b> / diff <b>${fmt(op?.difficulty || 0, 0)}</b> / keep-going <b>${op?.autoStart ? 'ON' : 'OFF'}</b>
              ${pendingRetune.has(ti) ? `<span style="margin-left:6px;opacity:0.9;">⏳ pending retune</span>` : ``}
            </div>
            <div style="margin-top:4px;opacity:0.9;">
              Best: ${cached ? `<b>${cached.hazardousBiomassStance}</b> / <b>${cached.artifactStance}</b> / diff <b>${cached.difficulty}</b> | ~<b>${fmt(cached.metrics?.artifactsPerHour, 1)}</b>/hr | recall ~<b>${fmt((cached.metrics?.recallProb || 0) * 100, 1)}%</b>` : '—'}
            </div>
          `;
          teamsBox.appendChild(row);
        }
      }

      if (CFG.showDiagnostics) {
        diag.style.display = 'block';
        diag.innerHTML = `
          <div style="font-weight:800;margin-bottom:4px;">Diagnostics</div>
          <div>Stories: <b>${Array.isArray(stories) ? stories.length : '—'}</b></div>
          <div>Last run: <b>${lastRunAt ? new Date(lastRunAt).toLocaleTimeString() : '—'}</b> | Cache: <b>${planCache.size}</b></div>
          <div style="opacity:0.85;">Clear cache only clears optimiser memory (not your save).</div>
        `;
      } else {
        diag.style.display = 'none';
      }
    }

    function makePanel() {
      if (!CFG.showPanel || panel) return;

      const el = document.createElement('div');
      el.id = 'tt-wgc-opt-panel';
      el.style.cssText = `
        position: fixed;
        z-index: 2147483647;
        width: ${CFG.panelWidth}px;
        background: rgba(18, 22, 30, 0.92);
        color: #e8eefc;
        border: 1px solid rgba(255,255,255,0.14);
        border-radius: 12px;
        box-shadow: 0 12px 40px rgba(0,0,0,0.45);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        font-size: 12px;
        padding: 10px;
        user-select: none;
      `;

      const pos = loadPos();
      if (pos && Number.isFinite(pos.left) && Number.isFinite(pos.top)) {
        el.style.left = `${pos.left}px`;
        el.style.top = `${pos.top}px`;
        el.style.right = 'auto';
        el.style.bottom = 'auto';
      } else {
        el.style.right = '12px';
        el.style.bottom = '12px';
      }

      el.innerHTML = `
        <div id="tt-wgc-dragbar" style="display:flex;gap:8px;align-items:center;margin-bottom:8px;cursor:move;">
          <div style="font-weight:800;flex:1;">WGC Optimiser & Manager</div>
          <label style="display:flex;gap:6px;align-items:center;opacity:0.95;cursor:pointer;">
            <input id="tt-wgc-enabled" type="checkbox" ${CFG.enabled ? 'checked' : ''} style="cursor:pointer;"/>
            Enabled
          </label>
          <button id="tt-wgc-clearcache" title="Clears ONLY optimiser plan cache; does NOT affect the game's save." style="${btnCss('rgba(255,255,255,0.06)','rgba(255,255,255,0.10)')}">Clear cache</button>
        </div>

        <div id="tt-wgc-status" style="margin-top:2px;opacity:0.92;line-height:1.35;"></div>
        <div id="tt-wgc-diag" style="margin-top:10px;opacity:0.78;line-height:1.35;"></div>
        <div id="tt-wgc-teams" style="margin-top:10px;display:flex;flex-direction:column;gap:8px;"></div>
      `;

      document.body.appendChild(el);
      panel = el;

      panel.querySelector('#tt-wgc-enabled').addEventListener('change', (e) => {
        CFG.enabled = !!e.target.checked;
        refreshPanel();
      });

      panel.querySelector('#tt-wgc-clearcache').addEventListener('click', () => {
        planCache.clear();
        pendingRetune.clear();
        refreshPanel();
      });

      // Drag
      const drag = panel.querySelector('#tt-wgc-dragbar');
      let dragging = false, startX = 0, startY = 0, startLeft = 0, startTop = 0;

      function ensureLeftTop() {
        const rect = panel.getBoundingClientRect();
        panel.style.left = `${rect.left}px`;
        panel.style.top = `${rect.top}px`;
        panel.style.right = 'auto';
        panel.style.bottom = 'auto';
      }

      drag.addEventListener('pointerdown', (e) => {
        const t = e.target;
        if (t && (t.tagName === 'INPUT' || t.tagName === 'BUTTON' || t.closest('button') || t.closest('label'))) return;

        dragging = true;
        panel.setPointerCapture(e.pointerId);
        ensureLeftTop();

        const rect = panel.getBoundingClientRect();
        startX = e.clientX;
        startY = e.clientY;
        startLeft = rect.left;
        startTop = rect.top;
        e.preventDefault();
      });

      drag.addEventListener('pointermove', (e) => {
        if (!dragging) return;
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const rect = panel.getBoundingClientRect();
        const next = clampToViewport(startLeft + dx, startTop + dy, rect);
        panel.style.left = `${next.left}px`;
        panel.style.top = `${next.top}px`;
      });

      drag.addEventListener('pointerup', (e) => {
        if (!dragging) return;
        dragging = false;
        try { panel.releasePointerCapture(e.pointerId); } catch (_) {}
        const rect = panel.getBoundingClientRect();
        savePos(rect.left, rect.top);
      });

      refreshPanel();
    }

    /********************************************************************
     * Boot
     ********************************************************************/
    function boot() {
      globalThis.ttWgcOpt = {
        __installed: true,
        CFG,
        getWGC,
        getResources,
        getStories,
        planCache,
        pendingRetune,
        clearCache: () => { planCache.clear(); pendingRetune.clear(); },
        optimiseNow: () => optimiseTickOnce(),
        setKeepGoing,
      };

      makePanel();

      setInterval(() => {
        try { refreshPanel(); } catch (_) {}
      }, CFG.uiRefreshMs);

      const run = () => {
        try {
          optimiseTickOnce();
          lastRunAt = Date.now();
          refreshPanel();
        } catch (e) {
          LOG('optimise error', e);
        }
      };

      // Run shortly after load, then every minute
      setTimeout(run, 1500);
      setInterval(run, CFG.optimiseEveryMs);
    }

    const wait = setInterval(() => {
      if (document.body) {
        clearInterval(wait);
        boot();
      }
    }, 50);
  }

  // Inject into PAGE scope (needed to access lexical globals like warpGateCommand)
  const s = document.createElement('script');
  s.id = 'tt-wgc-optimiser-injected-v11';
  s.textContent = `(${injectedMain.toString()})();`;
  (document.documentElement || document.head || document.body).appendChild(s);
  s.remove();
})();
