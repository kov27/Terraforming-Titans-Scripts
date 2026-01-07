// ==UserScript==
// @name         TT - WGC Optimiser & Manager
// @namespace    tt-wgc-optimizer
// @version      1.2.4
// @description  Async/non-freezing WGC optimiser + actual artifacts/hr (unit-correct) + compact export log.
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
  v1.2.1 fixes based on your export log:

  1) Actual artifacts/hr unit mismatch FIXED:
     Your log shows AA value ~18.3 while a single spend was ~654. That implies the internal AA pool is stored in "k-units"
     (e.g. 18.3 == 18,300 artifacts). Prior code tracked spend in raw artifacts, but tracked pool in k-units, inflating rates.
     Now we:
       - Detect a unitScale = (rawCost / deltaValueUnits) from real purchases.
       - Track BOTH:
           * netRate (pool change only)
           * grossEarnRate (pool change + spent, so spending doesn't look negative)
       - Show rates in real artifacts/hr using unitScale.

  2) Less hitching during recalculation:
     - Big reduction in compute by using a fast approximation during search (sample a few stories),
       then full-evaluating ONLY the top K stance pairs.
     - Optional throttling: CFG.maxRecalcTeamsPerCycle spreads heavy work across cycles.

  3) Better diagnostics:
     - Logs team start HP% when starting operations.
     - exportLog() stays compact.

  Notes:
  - Still defaults keepGoingMode='script' and respects minDeployHpRatio (no starting under threshold).
*/

(() => {
  'use strict';
  if (window.__ttWgcOptimiserInjectedV121__) return;
  window.__ttWgcOptimiserInjectedV121__ = true;

  function injectedMain() {
    'use strict';
    if (globalThis.ttWgcOpt && globalThis.ttWgcOpt.__installed) return;

    /********************************************************************
     * SETTINGS
     ********************************************************************/
    const CFG = {
      enabled: true,

      // Cadence
      optimiseEveryMs: 60_000,     // schedule a cycle each minute
      uiRefreshMs: 1_000,

      // Yield tuning (still yields between eval calls)
      computeBudgetMsPerSlice: 8,
      yieldEveryEvals: 16,

      // Spread heavy work (recalc) across cycles to avoid spikes
      maxRecalcTeamsPerCycle: 1,  // 1 = at most one team does heavy recompute per minute

      // Starting logic
      autoStartIdleTeams: true,
      minDeployHpRatio: 0.90,

      // Keep going behaviour
      keepGoingMode: 'script',     // 'script' | 'native'
      forceKeepGoingTick: true,    // only relevant in native mode

      // Active retune
      retuneModeWhenActive: 'finish', // 'finish' | 'recall' | 'never'

      // Spending / stats
      manageStats: true,           // respec+allocate ONLY when idle
      autoBuyWgtEquipment: true,
      alienArtifactReserve: 0,

      autoUpgradeFacilityWhenReady: true,
      facilityCandidates: ['library', 'shootingRange', 'obstacleCourse', 'infirmary'],

      // Optimiser bounds/shape
      difficultyMax: 5000,
      riskAversion: 10.0,
      maxRecallProb: 0.02,

      // Search speed/accuracy tradeoffs
      approxStorySample: 6,        // sampled stories during search
      fullVerifyTopKStancePairs: 3,// number of stance pairs to full-evaluate
      localItersApprox: 10,        // per stance pair, approx local search iterations

      // UI
      showPanel: true,
      showDiagnostics: true,
      panelWidth: 560,
    };

    /********************************************************************
     * Minimal structured log (small copy/paste)
     ********************************************************************/
    const LOG_RING = [];
    const LOG_MAX = 140;
    const now = () => Date.now();
    function logEvt(code, a=0,b=0,c=0,d=0) {
      // Compact: [t, code, a,b,c,d]
      LOG_RING.push([now(), code, a, b, c, d]);
      if (LOG_RING.length > LOG_MAX) LOG_RING.shift();
    }

    /********************************************************************
     * Lexical access helpers (game uses lexical globals)
     ********************************************************************/
    function getLex(name) {
      try { // eslint-disable-next-line no-new-func
        return Function(`return (typeof ${name} !== "undefined") ? ${name} : undefined;`)();
      } catch (_) { return undefined; }
    }
    function getWGC() { const wgc = getLex('warpGateCommand'); return (wgc && typeof wgc === 'object') ? wgc : null; }
    function getResources() { return getLex('resources') || globalThis.resources; }
    function getStories() { return getLex('WGC_OPERATION_STORIES') || globalThis.WGC_OPERATION_STORIES || null; }

    function tryUpdateWgcUI() {
      const fn = getLex('updateWGCUI') || globalThis.updateWGCUI;
      if (typeof fn === 'function') { try { fn(); } catch (_) {} }
    }

    /********************************************************************
     * Async yield scheduler
     ********************************************************************/
    function nextSlice() {
      return new Promise(resolve => {
        if (typeof requestIdleCallback === 'function') {
          requestIdleCallback(() => resolve(), { timeout: 50 });
        } else {
          requestAnimationFrame(() => resolve());
        }
      });
    }
    async function maybeYield(budget) {
      const t = performance.now();
      if ((t - budget.sliceStart) >= CFG.computeBudgetMsPerSlice || budget.evalSinceYield >= CFG.yieldEveryEvals) {
        budget.sliceStart = performance.now();
        budget.evalSinceYield = 0;
        budget.yields++;
        await nextSlice();
      }
    }

    /********************************************************************
     * Deterministic PRNG (for sampling stories)
     ********************************************************************/
    function xmur3(str) {
      let h = 1779033703 ^ str.length;
      for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
      }
      return function() {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h ^= h >>> 16;
        return h >>> 0;
      };
    }
    function mulberry32(a) {
      return function() {
        let t = a += 0x6D2B79F5;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    function sampleIndicesDeterministic(n, k, seedStr) {
      if (k >= n) { const all=[]; for(let i=0;i<n;i++) all.push(i); return all; }
      const seed = xmur3(seedStr)();
      const rnd = mulberry32(seed);
      const chosen = new Set();
      let guard = 0;
      while (chosen.size < k && guard++ < 10000) {
        const idx = Math.floor(rnd() * n);
        chosen.add(idx);
      }
      return Array.from(chosen);
    }

    /********************************************************************
     * WGC constants
     ********************************************************************/
    const BASE_EVENTS = [
      { name: 'Individual Team Power Challenge', type: 'individual', skill: 'power', aliases: ['Team Power Challenge'] },
      { name: 'Team Athletics Challenge', type: 'team', skill: 'athletics' },
      { name: 'Team Wits Challenge', type: 'team', skill: 'wit' },
      { name: 'Individual Athletics Challenge', type: 'individual', skill: 'athletics' },
      { name: 'Natural Science challenge', type: 'science', specialty: 'Natural Scientist', escalate: true, artifactMultiplier: 2 },
      { name: 'Social Science challenge', type: 'science', specialty: 'Social Scientist', escalate: true },
      { name: 'Combat challenge', type: 'combat' }
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
     * 4d20 suffix CDF
     ********************************************************************/
    const fourD20 = (() => {
      const pmf = new Array(81).fill(0);
      for (let a=1;a<=20;a++) for (let b=1;b<=20;b++) for (let c=1;c<=20;c++) for (let d=1;d<=20;d++) pmf[a+b+c+d] += 1;
      const total = Math.pow(20,4);
      const suffix = new Array(82).fill(0);
      let run=0;
      for (let s=80;s>=0;s--) { run += pmf[s] || 0; suffix[s] = run/total; }
      return { suffix };
    })();

    /********************************************************************
     * Math / helper functions
     ********************************************************************/
    const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
    function normCdf(z) {
      const t = 1 / (1 + 0.3275911 * Math.abs(z));
      const a1=0.254829592, a2=-0.284496736, a3=1.421413741, a4=-1.453152027, a5=1.061405429;
      const erf = 1 - (((((a5*t+a4)*t+a3)*t+a2)*t+a1)*t)*Math.exp(-z*z);
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
    function baseArtifactChance(equipPurchases) { return Math.min(0.1 + (equipPurchases||0)*0.001, 1); }
    function eventArtifactChance(event, equipPurchases, artifactStance) {
      let c = baseArtifactChance(equipPurchases);
      if (artifactStance === 'Rapid Extraction') return Math.max(0, c*0.25);
      if (artifactStance === 'Careful' && event && event.specialty === 'Natural Scientist') return Math.min(1, c*2);
      return c;
    }

    /********************************************************************
     * Skill totals
     ********************************************************************/
    function skillMultipliers(facilities) {
      const shootingRange = facilities.shootingRange || 0;
      const obstacleCourse = facilities.obstacleCourse || 0;
      const library = facilities.library || 0;
      return { pMult: 1 + shootingRange*0.01, aMult: 1 + obstacleCourse*0.01, wMult: 1 + library*0.01 };
    }
    function applyMult(val, skill, mults) {
      if (skill === 'power') return val * mults.pMult;
      if (skill === 'athletics') return val * mults.aMult;
      if (skill === 'wit') return val * mults.wMult;
      return val;
    }
    function teamSkillTotal(team, eventSkill, mults) {
      return team.reduce((s,m)=>{
        if (!m) return s;
        let contrib = applyMult(m[eventSkill], eventSkill, mults);
        if (eventSkill === 'wit' && (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist')) contrib *= 1.5;
        return s + contrib;
      }, 0);
    }
    function combatSkillTotal(team, mults) {
      return team.reduce((s,m)=>{
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
        if (v > highest) { highest=v; pool.length=0; pool.push(m); }
        else if (v === highest) pool.push(m);
      }
      return pool.length ? pool : team.filter(Boolean);
    }

    /********************************************************************
     * Keep-going checkbox helper
     ********************************************************************/
    function setKeepGoing(teamIndex, desired) {
      const wgc = getWGC();
      if (!wgc) return false;
      const op = wgc.operations?.[teamIndex];
      if (!op) return false;
      op.autoStart = !!desired;

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
     * Artifact tracking (UNIT-CORRECT)
     ********************************************************************/
    const artTrack = {
      unitScale: 1,           // real artifacts per value-unit (auto-detected)
      unitScaleConf: 0,       // confidence counter
      spentArtifacts: 0,      // raw artifact spend (real artifacts)
      spentValueUnits: 0,     // spend measured in value-units (delta pool)
      samples: [],            // [t, valueUnits, spentArtifacts]
      lastNet10: 0,
      lastGross10: 0,
      lastNet60: 0,
      lastGross60: 0,
    };

    function getArtifactValueUnits() {
      const res = getResources();
      const v = res?.special?.alienArtifact?.value;
      return Number.isFinite(v) ? v : null;
    }

    function updateUnitScaleFromPurchase(rawCost, deltaValueUnits) {
      if (!(rawCost > 0) || !(deltaValueUnits > 0)) return;
      const cand = rawCost / deltaValueUnits;
      if (!Number.isFinite(cand) || cand <= 0) return;
      // Accept only reasonable scales
      if (cand < 0.5 || cand > 1e9) return;

      if (artTrack.unitScaleConf === 0) {
        artTrack.unitScale = cand;
        artTrack.unitScaleConf = 1;
      } else {
        // Smooth a bit (EMA) to stabilize
        const a = 0.25;
        artTrack.unitScale = artTrack.unitScale * (1 - a) + cand * a;
        artTrack.unitScaleConf = Math.min(20, artTrack.unitScaleConf + 1);
      }
    }

    function sampleArtifacts() {
      const vUnits = getArtifactValueUnits();
      if (vUnits == null) return;

      const t = now();
      artTrack.samples.push([t, vUnits, artTrack.spentArtifacts]);
      const cutoff = t - 2*3600*1000;
      while (artTrack.samples.length && artTrack.samples[0][0] < cutoff) artTrack.samples.shift();

      const rateForWindow = (ms) => {
        const t1 = t;
        const t0 = t - ms;
        const arr = artTrack.samples;
        let i = 0;
        while (i < arr.length && arr[i][0] < t0) i++;
        const base = arr[Math.max(0, i-1)] || arr[0];
        if (!base) return { net:0, gross:0 };
        const dt = (t1 - base[0]) / 1000;
        if (dt <= 1) return { net:0, gross:0 };

        const dVUnits = (vUnits - base[1]);
        const dSpent = (artTrack.spentArtifacts - base[2]);

        const netArtifacts = dVUnits * artTrack.unitScale;         // includes spend (net change)
        const grossEarned = netArtifacts + dSpent;                  // add spent back to get earned

        return {
          net: (netArtifacts / dt) * 3600,
          gross: (grossEarned / dt) * 3600,
        };
      };

      const r10 = rateForWindow(10*60*1000);
      const r60 = rateForWindow(60*60*1000);
      artTrack.lastNet10 = r10.net;
      artTrack.lastGross10 = r10.gross;
      artTrack.lastNet60 = r60.net;
      artTrack.lastGross60 = r60.gross;
    }

    function patchSpendHooks() {
      const wgc = getWGC();
      if (!wgc || wgc.__ttSpendPatched) return;
      wgc.__ttSpendPatched = true;

      // Wrap purchaseUpgrade to measure actual pool delta (value units) + infer unitScale.
if (typeof wgc.purchaseUpgrade === 'function') {
  const orig = wgc.purchaseUpgrade.bind(wgc);

  wgc.purchaseUpgrade = function(upKey) {
    const vBefore = getArtifactValueUnits();

    let rawCost = 0;
    if (typeof wgc.getUpgradeCost === 'function') {
      try { rawCost = wgc.getUpgradeCost(upKey) || 0; } catch (_) { rawCost = 0; }
    }

    const ok = orig(upKey);

    if (ok) {
      const vAfter = getArtifactValueUnits();
      const deltaUnits = (vBefore != null && vAfter != null) ? Math.max(0, vBefore - vAfter) : 0;

      if (rawCost > 0) artTrack.spentArtifacts += rawCost;
      if (deltaUnits > 0) artTrack.spentValueUnits += deltaUnits;

      if (rawCost > 0 && deltaUnits > 0) updateUnitScaleFromPurchase(rawCost, deltaUnits);

      // 'S' spend event (rawCost, deltaVU*1e6, unitScale*1000, 0)
      if (rawCost > 0 || deltaUnits > 0) {
        logEvt('S',
          Math.round(rawCost),
          Math.round(deltaUnits * 1e6),
          Math.round(artTrack.unitScale * 1000),
          0
        );
      }
    }

    return ok;
  };
}

    }

    /********************************************************************
     * Event evaluation
     ********************************************************************/
    function evalEventOnce({
      team, facilities, equipPurchases, hazardStance, artifactStance,
      baseDifficulty, nextDiffMod, nextArtMod, event,
      forceStanceDifficultyModifier, combatDifficultyMultiplier, isImmediateCombat,
    }) {
      const mults = skillMultipliers(facilities);
      const facilityKey = facilityKeyForEvent(event);
      const facilityLevel = facilityKey ? (facilities[facilityKey] || 0) : 0;
      const hasFailSafe = facilityLevel >= 100;
      const hasReroll = (facilityKey ? getFacilityRerollBudget(facilityLevel) : 0) > 0;

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
      } else if (event.type === 'combat') {
        skillTotal = combatSkillTotal(team, mults);
        const cm = combatDifficultyMultiplier || 1;
        dc = Math.max(0, (40 * cm + 4 * difficultyForCheck) * stanceMod);
        damageEach = 5 * scaledDifficulty;
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
        damageOnFail = dmg;
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
      const rewardBase = 1 + baseDifficulty * 0.1;
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
      const dmgMean = members.map(()=>0);
      const dmgVar = members.map(()=>0);

      if (event.type === 'team' || event.type === 'combat') {
        const dmgEach = Math.max(0, damageEach);
        if (dmgEach > 0) {
          for (let i=0;i<members.length;i++){
            const p = pInitFail;
            dmgMean[i] += p * dmgEach;
            dmgVar[i] += p * (1-p) * (dmgEach*dmgEach);
          }
        }
      } else if (event.type === 'individual') {
        const dmg = Math.max(0, damageOnFail);
        if (dmg > 0) {
          for (const entry of individualSelection.entries) {
            const idx = members.indexOf(entry.m);
            if (idx < 0) continue;
            const p = entry.pSelect * entry.pInitFail;
            dmgMean[idx] += p * dmg;
            dmgVar[idx] += p * (1-p) * (dmg*dmg);
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
     * Story evaluation
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

    const storyListsCache = new Map(); // hazardStance -> lists
    function getStoryEventLists(hazardStance) {
      if (storyListsCache.has(hazardStance)) return storyListsCache.get(hazardStance);
      const stories = getStories();
      if (!Array.isArray(stories) || !stories.length) return null;
      const lists = stories.map(s => buildStoryEvents(s, hazardStance));
      storyListsCache.set(hazardStance, lists);
      return lists;
    }

    function evaluateStory({ storyEvents, team, facilities, equipPurchases, hazardStance, artifactStance, baseDifficulty }) {
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

      // Reduced cap to keep compute bounded
      for (let iter=0; iter<420; iter++) {
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
            if (!event) { endP += node.p; lastTimeW += node.lastW; continue; }

            const evRes = evalEventOnce({
              team, facilities, equipPurchases, hazardStance, artifactStance,
              baseDifficulty, nextDiffMod, nextArtMod,
              event, forceStanceDifficultyModifier: event._stanceMod,
              combatDifficultyMultiplier: 1, isImmediateCombat: false,
            });

            artW += node.p * evRes.expectedArtifacts;
            for (let i=0;i<members.length;i++){ dmgMeanW[i] += node.p * evRes.dmgMean[i]; dmgVarW[i] += node.p * evRes.dmgVar[i]; }

            const incBase = evRes.baseDelay + evRes.expectedExtraDelay;
            const baseNewTime = curTime + incBase;

            const isSocialScience = (event.type === 'science' && event.specialty === 'Social Scientist');
            const isNaturalEscalate = (event.type === 'science' && event.specialty === 'Natural Scientist' && event.escalate);

            for (const tr of evRes.trans) {
              if (tr.p <= 0) continue;
              const pBranch = node.p * tr.p;
              const newTimeW = pBranch * baseNewTime;
              const newLastW = pBranch * curTime;

              if (isSocialScience) {
                const pSucc = evRes.pInitSuccessNonIndividual != null ? evRes.pInitSuccessNonIndividual : 0;
                const pFail = 1 - pSucc;

                const pToCombat = pBranch * pFail;
                const pToNext = pBranch * (1 - pFail);

                if (pToCombat > 0) add(nextNodes, bi, 1, 1, 1, pToCombat, (pToCombat / pBranch) * newTimeW, (pToCombat / pBranch) * newLastW);
                if (pToNext > 0) add(nextNodes, bi + 1, 0, 1, 1, pToNext, (pToNext / pBranch) * newTimeW, (pToNext / pBranch) * newLastW);
              } else if (isNaturalEscalate) {
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
                for (let i=0;i<members.length;i++){ dmgMeanW[i] += pBranch * pFail * combatRes.dmgMean[i]; dmgVarW[i] += pBranch * pFail * combatRes.dmgVar[i]; }

                const extraTimeFromCombat = pFail * combatRes.expectedExtraDelay;
                add(nextNodes, bi + 1, 0, 1, 1, pBranch, pBranch * (baseNewTime + extraTimeFromCombat), newLastW);
              } else {
                add(nextNodes, bi + 1, 0, tr.nextDiffMod, tr.nextArtMod, pBranch, newTimeW, newLastW);
              }
            }
          } else {
            // inserted combat (queued)
            const combatEv = { name: 'Combat challenge', type: 'combat' };
            const evRes = evalEventOnce({
              team, facilities, equipPurchases, hazardStance, artifactStance,
              baseDifficulty, nextDiffMod: 1, nextArtMod: 1,
              event: combatEv,
              forceStanceDifficultyModifier: 1, // wgc.js quirk
              combatDifficultyMultiplier: 1.25,
              isImmediateCombat: false,
            });

            artW += node.p * evRes.expectedArtifacts;
            for (let i=0;i<members.length;i++){ dmgMeanW[i] += node.p * evRes.dmgMean[i]; dmgVarW[i] += node.p * evRes.dmgVar[i]; }

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
      };
    }

    /********************************************************************
     * evaluatePlan + caching (supports story subset)
     ********************************************************************/
    const evalCache = new Map();   // key -> result
    const EVAL_CACHE_MAX = 7000;

    function evalCacheGet(k) { return evalCache.get(k) || null; }
    function evalCacheSet(k, v) {
      evalCache.set(k, v);
      if (evalCache.size > EVAL_CACHE_MAX) {
        const it = evalCache.keys().next();
        if (!it.done) evalCache.delete(it.value);
      }
    }

    function evaluatePlan(team, facilities, equipPurchases, hazardStance, artifactStance, difficulty, storyIdxList /* optional */) {
      const storyEventLists = getStoryEventLists(hazardStance);
      if (!storyEventLists || !storyEventLists.length) return null;

      const indices = Array.isArray(storyIdxList) && storyIdxList.length
        ? storyIdxList
        : null;

      let art = 0;
      let lastTime = 0;

      const members = team.filter(Boolean);
      const dmgMean = new Array(members.length).fill(0);
      const dmgVar = new Array(members.length).fill(0);

      if (indices) {
        for (const idx of indices) {
          const storyEvents = storyEventLists[idx];
          if (!storyEvents) continue;
          const r = evaluateStory({ storyEvents, team, facilities, equipPurchases, hazardStance, artifactStance, baseDifficulty: difficulty });
          art += r.expectedArtifacts;
          lastTime += r.expectedLastTime;
          for (let i=0;i<members.length;i++){ dmgMean[i] += r.meanDamage[i]; dmgVar[i] += r.varDamage[i]; }
        }
      } else {
        for (const storyEvents of storyEventLists) {
          const r = evaluateStory({ storyEvents, team, facilities, equipPurchases, hazardStance, artifactStance, baseDifficulty: difficulty });
          art += r.expectedArtifacts;
          lastTime += r.expectedLastTime;
          for (let i=0;i<members.length;i++){ dmgMean[i] += r.meanDamage[i]; dmgVar[i] += r.varDamage[i]; }
        }
      }

      const n = indices ? Math.max(1, indices.length) : storyEventLists.length;
      const expArtifactsPerOp = art / n;
      const expLastTime = lastTime / n;
      const duration = Math.max(600, expLastTime);

      // Recall prob approx
      let recallProb = 0;
      if (members.length) {
        let survive = 1;
        for (let i=0;i<members.length;i++) {
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

      // Healing/downtime model (approx)
      const healMult = 1 + (facilities.infirmary || 0) * 0.01;
      const activeHeal = (duration / 60) * 1 * healMult;
      const idleHealPerSec = (50 / 60) * healMult;

      let percent = 0;
      const inf = facilities.infirmary || 0;
      if (inf >= 100) percent = 0.2;
      else if (inf >= 50) percent = 0.15;
      else if (inf >= 25) percent = 0.1;
      else if (inf >= 10) percent = 0.05;

      let worstDeficit = 0;
      let approxMaxHp = 100;
      for (let i=0;i<members.length;i++){
        const hp = members[i].maxHealth || (100 + (members[i].level - 1) * 10);
        approxMaxHp = Math.max(approxMaxHp, hp);
        const mu = dmgMean[i] / n;
        const deficit = Math.max(0, mu - activeHeal);
        worstDeficit = Math.max(worstDeficit, deficit);
      }
      worstDeficit = Math.max(0, worstDeficit - (percent * approxMaxHp));
      const restTime = idleHealPerSec > 0 ? (worstDeficit / idleHealPerSec) : 0;

      if (Number.isFinite(CFG.maxRecallProb) && recallProb > CFG.maxRecallProb) {
        return { score: -Infinity, artifactsPerHour: 0, recallProb, expArtifactsPerOp, duration, restTime };
      }

      const safeArtifacts = expArtifactsPerOp * (1 - recallProb);
      const cycleTime = duration + restTime;
      const artifactsPerHour = cycleTime > 0 ? (safeArtifacts / cycleTime) * 3600 : 0;
      const score = artifactsPerHour * Math.exp(-CFG.riskAversion * recallProb);

      return { score, artifactsPerHour, recallProb, expArtifactsPerOp, duration, restTime };
    }

    /********************************************************************
     * Optimisation search (approx -> full verify)
     ********************************************************************/
    function teamSignature(team, facilities, equip) {
      const members = team.map(m => [m.classType, m.level, m.power, m.athletics, m.wit].join(':')).join('|');
      const fac = ['infirmary','barracks','shootingRange','obstacleCourse','library'].map(k => `${k}=${facilities[k]||0}`).join(',');
      return `${members}||${fac}||equip=${equip}`;
    }

    async function optimiseForTeamAsync(team, facilities, equipPurchases, currentDifficulty, budget, sigKey) {
      const stories = getStories();
      if (!Array.isArray(stories) || !stories.length) return null;

      const storyCount = stories.length;
      const approxIdx = sampleIndicesDeterministic(storyCount, CFG.approxStorySample, sigKey + '|approx');

      const evalD = async (hz, ar, d, idxList /* null = full */) => {
        const tag = idxList ? ('A' + idxList.length) : 'F';
        const k = `${sigKey}|${hz}|${ar}|${d}|${tag}`;
        const cached = evalCacheGet(k);
        if (cached) return cached;

        budget.evalSinceYield++;
        budget.evals++;
        const r = evaluatePlan(team, facilities, equipPurchases, hz, ar, d, idxList || null);
        evalCacheSet(k, r);
        await maybeYield(budget);
        return r;
      };

      const clampD = (d) => clamp(Math.floor(d), 0, CFG.difficultyMax);

      const approxBestPerPair = [];

      for (const hz of HAZARD_STANCES) {
        for (const ar of ARTIFACT_STANCES) {
          let d = clampD(Number.isFinite(currentDifficulty) ? currentDifficulty : 0);
          let step = Math.max(10, Math.floor((d + 250) / 6));

          let cur = await evalD(hz, ar, d, approxIdx);
          if (!cur) continue;

          for (let iter=0; iter<CFG.localItersApprox; iter++) {
            const upD = clampD(d + step);
            const dnD = clampD(d - step);

            const up = (upD !== d) ? await evalD(hz, ar, upD, approxIdx) : cur;
            const dn = (dnD !== d) ? await evalD(hz, ar, dnD, approxIdx) : cur;

            const bestLocal = [{d, r:cur}, {d:upD, r:up}, {d:dnD, r:dn}]
              .filter(x => x.r)
              .sort((a,b)=>b.r.score - a.r.score)[0];

            if (bestLocal.d === d) {
              if (step <= 1) break;
              step = Math.max(1, Math.floor(step / 2));
            } else {
              d = bestLocal.d;
              cur = bestLocal.r;
            }
            await maybeYield(budget);
          }

          approxBestPerPair.push({ hz, ar, d, approx: cur });
        }
      }

      approxBestPerPair.sort((a,b)=> (b.approx?.score||-Infinity) - (a.approx?.score||-Infinity));
      const top = approxBestPerPair.slice(0, Math.max(1, CFG.fullVerifyTopKStancePairs));

      let bestFull = null;
      for (const cand of top) {
        const full = await evalD(cand.hz, cand.ar, cand.d, null);
        if (!full) continue;
        const obj = { hazardStance: cand.hz, artifactStance: cand.ar, difficulty: cand.d, r: full };
        if (!bestFull || obj.r.score > bestFull.r.score) bestFull = obj;
      }

      return bestFull;
    }

    /********************************************************************
     * Stats (idle only)
     ********************************************************************/
    function allocationFromWeights(points, wP, wA, wW) {
      const sum = wP+wA+wW;
      if (sum <= 0 || points <= 0) return { power:0, athletics:0, wit:0 };
      const raw = [
        {k:'power', v: points*(wP/sum)},
        {k:'athletics', v: points*(wA/sum)},
        {k:'wit', v: points*(wW/sum)}
      ];
      const base = { power:0, athletics:0, wit:0 };
      let used=0;
      for (const r of raw) { const f=Math.floor(r.v); base[r.k]=f; used+=f; r.frac=r.v-f; }
      let rem = points-used;
      raw.sort((a,b)=>b.frac-a.frac);
      for (let i=0;i<raw.length && rem>0;i++){ base[raw[i].k]+=1; rem--; }
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

        let wP=1,wA=1,wW=1;
        if (m.classType === 'Soldier') { wP = 7*mults.pMult; wA=2*mults.aMult; wW=1*mults.wMult; }
        else if (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist') { wP=1*mults.pMult; wA=2*mults.aMult; wW=8*mults.wMult; }
        else if (m.classType === 'Team Leader') { wP=3*mults.pMult; wA=3*mults.aMult; wW=4*mults.wMult; }

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
        logEvt('P', 0,0,0, pts);
      }
    }

    /********************************************************************
     * Spending
     ********************************************************************/
function tryAutoBuyWgtEquipment() {
  const wgc = getWGC();
  if (!wgc || !CFG.autoBuyWgtEquipment) return;

  const res = getResources();
  const art = res?.special?.alienArtifact;
  if (!art || typeof art.value !== 'number') return;

  const ups = wgc.rdUpgrades || {};
  const reserveVU = (CFG.alienArtifactReserve || 0) / Math.max(1e-9, artTrack.unitScale);

  const isMaxed = (k) => {
    const up = ups[k];
    if (!up) return true;
    const mx = (typeof up.max === 'number') ? up.max : null;
    return (mx != null) ? ((up.purchases || 0) >= mx) : false;
  };

const isAvailable = (k) => {
  const up = ups[k];
  if (!up) return false;

  // Only respect the upgrade's own enabled flag (if present).
  // Do NOT hard-gate on research flags; the game will refuse purchase if locked.
  if (up.enabled === false) return false;

  return true;
};


  const getCost = (k) => {
    try {
      if (typeof wgc.getUpgradeCost === 'function') return (wgc.getUpgradeCost(k) || 0);
    } catch (_) {}
    // Fallback (should rarely be used)
    const up = ups[k];
    return up ? ((up.purchases || 0) + 1) : 0;
  };

  const pickCheapestOtherUpgrade = () => {
    let bestKey = null;
    let bestCost = Infinity;

    for (const k of Object.keys(ups)) {
      if (k === 'wgtEquipment') continue;
      if (!isAvailable(k)) continue;
      if (isMaxed(k)) continue;

      const c = getCost(k);
      if (!(c > 0)) continue;

      if (c < bestCost) {
        bestCost = c;
        bestKey = k;
      }
    }
    return bestKey;
  };

  // Conservative limit per cycle to avoid burst spend + UI hitching
  let buys = 0;
  while (buys < 3) {
    let key = null;

    if (ups.wgtEquipment && !isMaxed('wgtEquipment')) {
      key = 'wgtEquipment';
    } else {
      key = pickCheapestOtherUpgrade();
    }

    if (!key) break;

    const cost = getCost(key);
    if (!(cost > 0)) break;

    // Reserve check only if unitScale is known; otherwise let game reject unaffordable purchases.
    if (artTrack.unitScaleConf > 0) {
      const costVU = cost / Math.max(1e-9, artTrack.unitScale);
      if ((art.value - costVU) < reserveVU) break;
    }

    const ok = wgc.purchaseUpgrade && wgc.purchaseUpgrade(key);
    if (!ok) break;

    buys++;
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
      for (let ti=0;ti<4;ti++) {
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
          const r = evaluatePlan(team, fac, equip, 'Neutral', 'Neutral', currentDiff, null);
          sum += (r?.artifactsPerHour || 0);
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

      if (best.key && typeof wgc.upgradeFacility === 'function') {
        wgc.upgradeFacility(best.key);
        logEvt('F', 0,0,0, 0);
      }
    }

    /********************************************************************
     * Plan caches + control
     ********************************************************************/
    const planCache = new Map(); // teamIndex -> { sig, plan, ts }
    const pendingRetune = new Map(); // teamIndex -> plan

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

      if (typeof wgc.setStance === 'function') wgc.setStance(teamIndex, plan.hazardousBiomassStance);
      if (typeof wgc.setArtifactStance === 'function') wgc.setArtifactStance(teamIndex, plan.artifactStance);
      op.difficulty = plan.difficulty;

      if (CFG.keepGoingMode === 'native' && CFG.forceKeepGoingTick) setKeepGoing(teamIndex, true);
      if (CFG.keepGoingMode === 'script') setKeepGoing(teamIndex, false);

      tryUpdateWgcUI();
      logEvt('A', teamIndex, 0, 0, plan.difficulty);
      return true;
    }

    function teamHpRatio(team) {
      const members = team.filter(Boolean);
      if (!members.length) return 0;
      let minR = 1;
      for (const m of members) {
        const r = (m.maxHealth > 0) ? (m.health / m.maxHealth) : 0;
        if (r < minR) minR = r;
      }
      return minR;
    }
    function teamReady(team) { return teamHpRatio(team) >= CFG.minDeployHpRatio; }

    /********************************************************************
     * Recalc throttling queue
     ********************************************************************/
    const recalcQueue = [];
    function enqueueRecalc(teamIndex) {
      if (recalcQueue.indexOf(teamIndex) === -1) recalcQueue.push(teamIndex);
    }

    /********************************************************************
     * Async optimisation cycle
     ********************************************************************/
    const optState = {
      running: false,
      requested: false,
      lastCycleAt: 0,
      lastCycleMs: 0,
      lastYields: 0,
      lastEvals: 0,
      lastPredTotal: 0,
    };

    function needRecalc(teamIndex, sig) {
      const cached = planCache.get(teamIndex);
      if (!cached) return true;
      if (cached.sig !== sig) return true;
      if ((now() - (cached.ts || 0)) > 20*60*1000) return true;
      return false;
    }

    async function computePlanForTeam(teamIndex, budget, allowHeavy) {
      const wgc = getWGC();
      if (!wgc) return null;

      const team = wgc.teams?.[teamIndex];
      if (!Array.isArray(team) || team.some(m => !m)) return null;

      const facilities = { ...(wgc.facilities || {}) };
      const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;
      const curDiff = wgc.operations?.[teamIndex]?.difficulty || 0;

      const sig = teamSignature(team, facilities, equip);

      const needs = needRecalc(teamIndex, sig);
      if (needs) enqueueRecalc(teamIndex);

      const cached = planCache.get(teamIndex);
      if (!allowHeavy || !needs) {
        return cached ? cached.plan : null;
      }

      const op = wgc.operations?.[teamIndex];
      if (CFG.manageStats && op && !op.active) applyOptimisedStats(team, facilities);

      const sig2 = teamSignature(team, facilities, equip);

      logEvt('C', teamIndex, 0, 0, 0);

      const best = await optimiseForTeamAsync(team, facilities, equip, curDiff, budget, sig2);
      if (!best) return cached ? cached.plan : null;

      const plan = {
        hazardousBiomassStance: best.hazardStance,
        artifactStance: best.artifactStance,
        difficulty: best.difficulty,
        metrics: best.r,
      };

      planCache.set(teamIndex, { sig: sig2, plan, ts: now() });
      // mark as processed in queue
      const qi = recalcQueue.indexOf(teamIndex);
      if (qi !== -1) recalcQueue.splice(qi, 1);

      return plan;
    }

    async function runOptimisationCycle() {
      if (optState.running) return;
      optState.running = true;
      optState.requested = false;

      const budget = { sliceStart: performance.now(), evalSinceYield: 0, yields: 0, evals: 0 };

      const tStart = performance.now();
      const wgc = getWGC();
      if (!wgc || !wgc.enabled) { optState.running = false; return; }

      patchSpendHooks();
      sampleArtifacts();

      if (CFG.autoBuyWgtEquipment) tryAutoBuyWgtEquipment();
      if (CFG.autoUpgradeFacilityWhenReady) tryAutoUpgradeFacility();

      // Decide which teams may do heavy recompute this cycle
      let heavySlots = CFG.maxRecalcTeamsPerCycle;
      const heavyAllow = new Set();
      while (heavySlots > 0 && recalcQueue.length > 0) {
        heavyAllow.add(recalcQueue[0]);
        heavySlots--;
        // keep in queue until successfully computed (removed there)
        break;
      }

      // Predicted total
      let predTotal = 0;
      for (const v of planCache.values()) predTotal += Number(v?.plan?.metrics?.artifactsPerHour || 0);
      optState.lastPredTotal = predTotal;

      for (let ti=0; ti<4; ti++) {
        if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
        const team = wgc.teams?.[ti];
        if (!Array.isArray(team) || team.some(m => !m)) continue;

        const op = wgc.operations?.[ti];
        if (!op) continue;

        if (CFG.keepGoingMode === 'script') setKeepGoing(ti, false);
        else if (!op.active && CFG.forceKeepGoingTick) setKeepGoing(ti, true);

        if (!op.active && pendingRetune.has(ti)) {
          const plan = pendingRetune.get(ti);
          pendingRetune.delete(ti);
          applyPlanIfIdle(ti, plan);

          if (CFG.autoStartIdleTeams && teamReady(team) && typeof wgc.startOperation === 'function') {
            const hp = Math.round(teamHpRatio(team)*100);
            wgc.startOperation(ti, plan.difficulty);
            if (CFG.keepGoingMode === 'native' && CFG.forceKeepGoingTick) setKeepGoing(ti, true);
            tryUpdateWgcUI();
            logEvt('T', ti, hp, 0, plan.difficulty);
          }
          await maybeYield(budget);
          continue;
        }

        const allowHeavy = heavyAllow.has(ti);
        const plan = await computePlanForTeam(ti, budget, allowHeavy);
        if (!plan) { await maybeYield(budget); continue; }

        if (op.active) {
          if (planDiffersFromCurrent(ti, plan)) {
            if (CFG.keepGoingMode === 'script') {
              if (CFG.retuneModeWhenActive === 'recall' && typeof wgc.recallTeam === 'function') {
                wgc.recallTeam(ti);
                pendingRetune.set(ti, plan);
                logEvt('R', ti, 2, 0, 0);
              } else if (CFG.retuneModeWhenActive !== 'never') {
                pendingRetune.set(ti, plan);
                logEvt('Q', ti, 0, 0, 0);
              }
            } else {
              if (CFG.retuneModeWhenActive === 'finish') {
                setKeepGoing(ti, false);
                pendingRetune.set(ti, plan);
                logEvt('Q', ti, 1, 0, 0);
              } else if (CFG.retuneModeWhenActive === 'recall' && typeof wgc.recallTeam === 'function') {
                wgc.recallTeam(ti);
                pendingRetune.set(ti, plan);
                logEvt('R', ti, 2, 0, 0);
              }
            }
          }
          await maybeYield(budget);
          continue;
        }

        applyPlanIfIdle(ti, plan);

        if (CFG.autoStartIdleTeams && teamReady(team) && typeof wgc.startOperation === 'function') {
          const hp = Math.round(teamHpRatio(team)*100);
          wgc.startOperation(ti, plan.difficulty);
          if (CFG.keepGoingMode === 'native' && CFG.forceKeepGoingTick) setKeepGoing(ti, true);
          tryUpdateWgcUI();
          logEvt('T', ti, hp, 0, plan.difficulty);
        } else {
          logEvt('N', ti, Math.round(teamHpRatio(team)*100), 0, plan.difficulty);
        }

        await maybeYield(budget);
      }

      optState.lastCycleAt = now();
      optState.lastCycleMs = performance.now() - tStart;
      optState.lastYields = budget.yields;
      optState.lastEvals = budget.evals;

      optState.running = false;

      if (optState.requested) {
        optState.requested = false;
        setTimeout(() => runOptimisationCycle(), 250);
      }
    }

    function scheduleCycle() {
      if (!CFG.enabled) return;
      optState.requested = true;
      logEvt('Z', 0, 0, 0, 0);
      if (!optState.running) runOptimisationCycle();
    }

    function forceRecalc() {
      planCache.clear();
      recalcQueue.length = 0;
      // queue all teams
      for (let i=0;i<4;i++) recalcQueue.push(i);
      scheduleCycle();
    }

    /********************************************************************
     * UI (draggable)
     ********************************************************************/
    const LS_POS_KEY = 'ttWgcOpt.panelPos.v121';
    let panel = null;

    function loadPos() { try { const raw = localStorage.getItem(LS_POS_KEY); return raw ? JSON.parse(raw) : null; } catch (_) { return null; } }
    function savePos(left, top) { try { localStorage.setItem(LS_POS_KEY, JSON.stringify({ left, top })); } catch (_) {} }
    function clampToViewport(left, top, rect) {
      const w = rect?.width || CFG.panelWidth;
      const h = rect?.height || 260;
      const MIN_VISIBLE = 28;
      const minL = -w + MIN_VISIBLE;
      const maxL = window.innerWidth - MIN_VISIBLE;
      const minT = -h + MIN_VISIBLE;
      const maxT = window.innerHeight - MIN_VISIBLE;
      return { left: clamp(left, minL, maxL), top: clamp(top, minT, maxT) };
    }

    const btnCss = (bg, bd) => `all:unset;cursor:pointer;padding:6px 9px;border-radius:10px;background:${bg};border:1px solid ${bd};`;
    function fmt(x, d=1) { return Number.isFinite(x) ? x.toFixed(d) : '—'; }
    function fmtI(x) { return Number.isFinite(x) ? Math.round(x).toString() : '—'; }

    function refreshPanel() {
      if (!panel) return;

      const wgc = getWGC();
      const vUnits = getArtifactValueUnits();
      const equip = wgc?.rdUpgrades?.wgtEquipment?.purchases || 0;
      const cd = wgc?.facilityCooldown || 0;

      sampleArtifacts();

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
        const unitScale = artTrack.unitScale;
        const conf = artTrack.unitScaleConf;

        const poolArtifacts = (vUnits != null) ? (vUnits * unitScale) : null;

        status.innerHTML = `
          <div>AA pool: <b>${vUnits != null ? fmt(vUnits,3) : '—'}</b> value-units (~<b>${poolArtifacts != null ? fmtI(poolArtifacts) : '—'}</b> artifacts) | unitScale: <b>${fmt(unitScale,1)}</b> (${conf}/20)</div>
          <div>wgtEquipment: <b>${equip}</b> | Facility CD: <b>${fmt(cd,0)}s</b> | Spent (tracked): <b>${fmtI(artTrack.spentArtifacts)}</b></div>
          <div style="opacity:0.92;">
            Actual <b>NET</b>: <b>${fmtI(artTrack.lastNet10)}</b>/hr (10m) • <b>${fmtI(artTrack.lastNet60)}</b>/hr (60m)
            &nbsp;|&nbsp; Actual <b>GROSS</b>: <b>${fmtI(artTrack.lastGross10)}</b>/hr (10m) • <b>${fmtI(artTrack.lastGross60)}</b>/hr (60m)
          </div>
          <div style="opacity:0.85;">Pred total (cached): <b>${fmtI(optState.lastPredTotal)}</b>/hr | Mode: <b>${CFG.keepGoingMode}</b> | Min deploy HP: <b>${Math.round(CFG.minDeployHpRatio*100)}%</b></div>
        `;

        teamsBox.innerHTML = '';
        for (let ti=0; ti<4; ti++) {
          if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
          const team = wgc.teams?.[ti];
          if (!Array.isArray(team)) continue;
          const op = wgc.operations?.[ti];
          const stanceObj = wgc.stances?.[ti] || { hazardousBiomass:'Neutral', artifact:'Neutral' };

          const cached = planCache.get(ti)?.plan || null;

          const fullTeam = team.every(m => m);
          const hp = fullTeam ? teamHpRatio(team.filter(Boolean)) : 0;
          const ready = fullTeam && (hp >= CFG.minDeployHpRatio);
          const active = !!op?.active;

          const row = document.createElement('div');
          row.style.cssText = `padding:8px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);`;

          row.innerHTML = `
            <div style="display:flex;gap:8px;align-items:center;">
              <div style="font-weight:800;flex:1;">${wgc.teamNames?.[ti] || `Team ${ti+1}`}</div>
              <div style="opacity:0.9;">${active ? '🟩 active' : (ready ? '🟦 ready' : '⬛ resting')}</div>
              <div style="opacity:0.85;">HP <b>${Math.round(hp*100)}%</b></div>
            </div>
            <div style="margin-top:6px;opacity:0.9;">
              Current: <b>${stanceObj.hazardousBiomass}</b> / <b>${stanceObj.artifact}</b> / diff <b>${fmt(op?.difficulty||0,0)}</b> / keep-going <b>${op?.autoStart ? 'ON':'OFF'}</b>
              ${pendingRetune.has(ti) ? `<span style="margin-left:6px;opacity:0.9;">⏳ pending</span>` : ``}
            </div>
            <div style="margin-top:4px;opacity:0.9;">
              Pred: ${cached ? `<b>${cached.hazardousBiomassStance}</b> / <b>${cached.artifactStance}</b> / diff <b>${cached.difficulty}</b> | <b>${fmtI(cached.metrics?.artifactsPerHour)}</b>/hr | recall <b>${fmt((cached.metrics?.recallProb||0)*100,2)}%</b>` : '—'}
            </div>
          `;
          teamsBox.appendChild(row);
        }
      }

      if (CFG.showDiagnostics) {
        diag.style.display = 'block';
        diag.innerHTML = `
          <div style="font-weight:800;margin-bottom:4px;">Diagnostics</div>
          <div>Cycle: <b>${optState.running ? 'RUNNING' : 'idle'}</b> | last: <b>${fmt(optState.lastCycleMs,0)}ms</b> | yields: <b>${optState.lastYields}</b> | evals: <b>${optState.lastEvals}</b></div>
          <div>Plan cache: <b>${planCache.size}</b> | Eval cache: <b>${evalCache.size}</b> | RecalcQ: <b>${recalcQueue.length}</b> | Events: <b>${LOG_RING.length}</b></div>
          <div style="opacity:0.85;">Export log: <code>copy(ttWgcOpt.exportLog())</code></div>
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
          <button id="tt-wgc-recalc" title="Queues recalculation (spread across cycles)." style="${btnCss('rgba(255,255,255,0.10)','rgba(255,255,255,0.14)')}">Recalc</button>
        </div>

        <div id="tt-wgc-status" style="margin-top:2px;opacity:0.92;line-height:1.35;"></div>
        <div id="tt-wgc-diag" style="margin-top:10px;opacity:0.78;line-height:1.35;"></div>
        <div id="tt-wgc-teams" style="margin-top:10px;display:flex;flex-direction:column;gap:8px;"></div>
      `;

      document.body.appendChild(el);
      panel = el;

      panel.querySelector('#tt-wgc-enabled').addEventListener('change', (e) => {
        CFG.enabled = !!e.target.checked;
        if (CFG.enabled) scheduleCycle();
        refreshPanel();
      });
      panel.querySelector('#tt-wgc-recalc').addEventListener('click', () => { forceRecalc(); refreshPanel(); });

      // Drag (movement threshold + global release)
      const drag = panel.querySelector('#tt-wgc-dragbar');
      let dragPending=false, dragging=false, startX=0,startY=0,startLeft=0,startTop=0;

      function isInteractiveTarget(t){
        if (!t) return false;
        const tag=(t.tagName||'').toUpperCase();
        if (tag==='INPUT'||tag==='BUTTON'||tag==='SELECT'||tag==='TEXTAREA') return true;
        return !!(t.closest && (t.closest('button')||t.closest('label')||t.closest('input')||t.closest('select')||t.closest('textarea')));
      }

      function onMove(e){
        if (!dragPending) return;
        const dx=e.clientX-startX, dy=e.clientY-startY;
        if (!dragging) {
          if (Math.abs(dx)<4 && Math.abs(dy)<4) return;
          dragging=true;
          const rect=panel.getBoundingClientRect();
          panel.style.left = `${rect.left}px`;
          panel.style.top = `${rect.top}px`;
          panel.style.right='auto'; panel.style.bottom='auto';
        }
        const rect=panel.getBoundingClientRect();
        const next=clampToViewport(startLeft+dx, startTop+dy, rect);
        panel.style.left=`${next.left}px`;
        panel.style.top=`${next.top}px`;
        e.preventDefault();
      }

      function endDrag(){
        if (!dragPending) return;
        dragPending=false;
        document.removeEventListener('pointermove', onMove, true);
        document.removeEventListener('pointerup', onUp, true);
        document.removeEventListener('pointercancel', onCancel, true);
        if (dragging){
          dragging=false;
          const rect=panel.getBoundingClientRect();
          savePos(rect.left, rect.top);
        } else dragging=false;
      }
      function onUp(){ endDrag(); }
      function onCancel(){ endDrag(); }

      drag.addEventListener('pointerdown', (e)=>{
        if (e.button!=null && e.button!==0) return;
        if (isInteractiveTarget(e.target)) return;
        dragPending=true; dragging=false;
        const rect=panel.getBoundingClientRect();
        startX=e.clientX; startY=e.clientY; startLeft=rect.left; startTop=rect.top;
        document.addEventListener('pointermove', onMove, true);
        document.addEventListener('pointerup', onUp, true);
        document.addEventListener('pointercancel', onCancel, true);
      });
      window.addEventListener('blur', ()=>endDrag(), true);

      refreshPanel();
    }

    /********************************************************************
     * Export log (compact JSON)
     ********************************************************************/
    function exportLog() {
      const wgc = getWGC();
      const vUnits = getArtifactValueUnits();

      const teams = [];
      if (wgc) {
        for (let ti=0; ti<4; ti++) {
          if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
          const t = wgc.teams?.[ti];
          if (!Array.isArray(t)) continue;
          const op = wgc.operations?.[ti];
          const st = wgc.stances?.[ti] || {};
          const cached = planCache.get(ti);
          teams.push([
            ti,
            op ? (op.active ? 1 : 0) : -1,
            op ? (op.difficulty||0) : 0,
            op ? (op.autoStart?1:0) : 0,
            st.hazardousBiomass || '',
            st.artifact || '',
            t.every(m=>m) ? Math.round(teamHpRatio(t)*100) : -1,
            cached ? [cached.plan?.hazardousBiomassStance||'', cached.plan?.artifactStance||'', cached.plan?.difficulty||0, Number(cached.plan?.metrics?.artifactsPerHour||0), Number(cached.plan?.metrics?.recallProb||0)] : null,
            pendingRetune.has(ti) ? 1 : 0
          ]);
        }
      }

      const payload = {
        v: '1.2.1',
        t: now(),
        cfg: {
          e:+CFG.enabled,
          md:CFG.minDeployHpRatio,
          kg:CFG.keepGoingMode,
          ra:CFG.riskAversion,
          mr:CFG.maxRecallProb,
          b:CFG.computeBudgetMsPerSlice,
          y:CFG.yieldEveryEvals,
          q:CFG.maxRecalcTeamsPerCycle,
          ss:CFG.approxStorySample,
          k:CFG.fullVerifyTopKStancePairs
        },
        perf: {
          run:+optState.running,
          ms:optState.lastCycleMs,
          yd:optState.lastYields,
          ev:optState.lastEvals,
          pc: planCache.size,
          ec: evalCache.size,
          rq: recalcQueue.length,
          pr: optState.lastPredTotal
        },
        art: {
          vu: (vUnits != null) ? vUnits : null,
          sc: artTrack.unitScale,
          cf: artTrack.unitScaleConf,
          sp: artTrack.spentArtifacts,
          n10: artTrack.lastNet10,
          g10: artTrack.lastGross10,
          n60: artTrack.lastNet60,
          g60: artTrack.lastGross60
        },
        tm: teams,
        ev: LOG_RING
      };

      return JSON.stringify(payload);
    }

    /********************************************************************
     * Boot
     ********************************************************************/
    function boot() {
      makePanel();

      globalThis.ttWgcOpt = {
        __installed: true,
        CFG,
        exportLog,
        forceRecalc,
        scheduleCycle,
        getWGC,
        setKeepGoing,
      };

      setInterval(() => { try { refreshPanel(); } catch (_) {} }, CFG.uiRefreshMs);

      // prime recalc queue (teams will fill as signatures seen)
      setTimeout(() => scheduleCycle(), 1500);
      setInterval(() => scheduleCycle(), CFG.optimiseEveryMs);
    }

    const wait = setInterval(() => {
      if (document.body) { clearInterval(wait); boot(); }
    }, 50);
  }

  // Inject into PAGE scope
  const s = document.createElement('script');
  s.id = 'tt-wgc-optimiser-injected-v121';
  s.textContent = `(${injectedMain.toString()})();`;
  (document.documentElement || document.head || document.body).appendChild(s);
  s.remove();
})();
