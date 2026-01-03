// ==UserScript==
// @name         TT - WGC Optimiser & Manager
// @namespace    tt-wgc-optimizer
// @version      1.2.3
// @description  Deterministic WGC optimiser/manager. Performance-focused: cooperative time-slicing + fewer evals (no game freezes).
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /********************************************************************
   * NOTES (what changed in v1.2.2)
   * - Recalc no longer blocks the game: optimisation runs in small time slices via requestIdleCallback/setTimeout.
   * - Much fewer expensive plan evaluations: coarse grid + local refinement (still deterministic).
   * - Faster story evaluation: fixed-size arrays (no Maps/strings) and re-use of precomputed story templates.
   *
   * Global API:
   *   window.ttWgcOpt.dumpLog()     -> compact JSON string
   *   window.ttWgcOpt.forceRecalc() -> queue recompute now
   *   window.ttWgcOpt.CFG           -> live config (edit in console)
   ********************************************************************/

  /********************************************************************
   * SETTINGS (edit here if you like)
   ********************************************************************/
  const CFG = {
    enabled: true,

    // Optimisation cadence
    optimiseEveryMs: 60_000,

    // Cooperative scheduler budget (keep small to avoid jank)
    perfBudgetMs: 7,              // max ms per slice doing optimisation work
    sliceGapMs: 8,                // delay between slices (lets the game render)

    // Objective/risk
    riskAversion: 10,             // higher => safer (fewer recalls), can increase rest time
    difficultyMax: 5000,

    // (Deterministic) search settings (performance knob)
    searchSamples: 11,            // coarse grid samples per stance pair
    refineIters: 10,              // local refinement iterations per stance pair

    // Deployment gating
    minDeployHpRatio: 0.90,       // only start a NEW operation if all members >= this ratio
    allowStartWhileResting: false,// if true, ignore hp gating (not recommended)

    // Spend / upgrades (unchanged behaviour)
    autoBuyWgtEquipment: true,
    alienArtifactReserve: 0,
    autoUpgradeFacilityWhenReady: true,
    facilityCandidates: ['library', 'shootingRange', 'obstacleCourse', 'infirmary'],

    // Logging
    eventLogMax: 450,             // ring buffer size
    sampleEveryMs: 15_000,        // artifact sampling interval
    window10mMs: 10 * 60_000,
    window60mMs: 60 * 60_000,

    // Minimal on-screen HUD (so you can see it's working)
    showHud: true,
    hudUpdateMs: 2000,
    hudStartMinimized: false,
    hudAllowAlmostOffscreen: true,
  };

  const W = window;

  /********************************************************************
   * SAFE GAME ACCESS
   ********************************************************************/
  function getGameWindow() {
    // In most cases the game runs in the current frame.
    // If not found, try walking child frames (same-origin only).
    if (W && W.warpGateCommand) return W;
    try {
      if (W && W.frames && W.frames.length) {
        for (let i = 0; i < W.frames.length; i++) {
          const f = W.frames[i];
          try { if (f && f.warpGateCommand) return f; } catch (_) {}
        }
      }
    } catch (_) {}
    return W;
  }
  function getWGC() {
    const gw = getGameWindow();
    return gw ? gw.warpGateCommand : null;
  }

  /********************************************************************
   * CONSTANTS / TEMPLATES (mirrors wgc.js)
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

  const NEXT_DIFF = [1, 0.75];
  const NEXT_ART = [1, 2, 0.5];

  const baseEventTemplatesByName = (() => {
    const map = Object.create(null);
    for (const evt of BASE_EVENTS) {
      const { aliases, ...template } = evt;
      map[evt.name] = { ...template };
      if (Array.isArray(aliases)) {
        for (const alias of aliases) {
          if (!(alias in map)) map[alias] = { ...template };
        }
      }
    }
    return map;
  })();

  /********************************************************************
   * 4d20 suffix CDF (precompute once)
   ********************************************************************/
  const fourD20Suffix = (() => {
    const pmf = new Uint32Array(81);
    for (let a = 1; a <= 20; a++)
      for (let b = 1; b <= 20; b++)
        for (let c = 1; c <= 20; c++)
          for (let d = 1; d <= 20; d++)
            pmf[a + b + c + d] += 1;
    const total = 20 ** 4;
    const suffix = new Float64Array(82);
    let running = 0;
    for (let s = 80; s >= 0; s--) {
      running += pmf[s];
      suffix[s] = running / total;
    }
    return suffix;
  })();

  /********************************************************************
   * HELPERS
   ********************************************************************/
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function now() { return Date.now(); }

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
    return fourD20Suffix[needed];
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
    let s = 0;
    for (let i = 0; i < team.length; i++) {
      const m = team[i];
      if (!m) continue;
      let contrib = applyMult(m[eventSkill], eventSkill, mults);
      if (eventSkill === 'wit' && (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist')) contrib *= 1.5;
      s += contrib;
    }
    return s;
  }

  function combatSkillTotal(team, mults) {
    let s = 0;
    for (let i = 0; i < team.length; i++) {
      const m = team[i];
      if (!m) continue;
      const mult = (m.classType === 'Soldier') ? 2 : 1;
      s += applyMult(m.power, 'power', mults) * mult;
    }
    return s;
  }

  function pickAthleticsPool(team) {
    let highest = Number.NEGATIVE_INFINITY;
    const pool = [];
    for (let i = 0; i < team.length; i++) {
      const m = team[i];
      if (!m) continue;
      const v = m.athletics;
      if (v > highest) {
        highest = v;
        pool.length = 0;
        pool.push(m);
      } else if (v === highest) {
        pool.push(m);
      }
    }
    return pool.length ? pool : team.filter(Boolean);
  }

  function getHpRatio(member) {
    if (!member) return 0;
    const h = (typeof member.health === 'number') ? member.health
      : (typeof member.hp === 'number') ? member.hp
      : (typeof member.currentHealth === 'number') ? member.currentHealth
      : 0;
    const mh = (typeof member.maxHealth === 'number') ? member.maxHealth
      : (typeof member.maxHp === 'number') ? member.maxHp
      : (typeof member.maximumHealth === 'number') ? member.maximumHealth
      : (typeof member.level === 'number') ? (100 + (member.level - 1) * 10)
      : 100;
    if (mh <= 0) return 0;
    return clamp(h / mh, 0, 1);
  }

  function teamReady(team) {
    if (CFG.allowStartWhileResting) return true;
    for (let i = 0; i < team.length; i++) {
      const m = team[i];
      if (!m) return false;
      if (getHpRatio(m) < CFG.minDeployHpRatio) return false;
    }
    return true;
  }

  /********************************************************************
   * PRECOMPUTE STORIES ONCE
   ********************************************************************/
  let STORY_CACHE = null; // { stories, storyEventsByHazard: Map(hz -> array[storyIndex] -> eventArr) }
  function getStoriesPrecomputed() {
    const gw = getGameWindow();
    const stories = (gw && Array.isArray(gw.WGC_OPERATION_STORIES)) ? gw.WGC_OPERATION_STORIES : null;
    if (!stories || !stories.length) return null;

    if (STORY_CACHE && STORY_CACHE.src === stories) return STORY_CACHE;

    // Base story events: merge template fields onto story fields
    const baseEvents = stories.map((s) => {
      const raw = (s && Array.isArray(s.events)) ? s.events.slice(0, 10) : [];
      const out = new Array(raw.length);
      for (let i = 0; i < raw.length; i++) {
        const se = raw[i];
        const template = baseEventTemplatesByName[se.name] || null;
        const ev = template ? { ...template } : { name: se.name };
        // only override with story fields when not an alias substitution
        const usedAlias = !!(template && template.name !== se.name);
        if (se.type && !usedAlias) ev.type = se.type;
        if (se.skill && !usedAlias) ev.skill = se.skill;
        if (se.specialty && !usedAlias) ev.specialty = se.specialty;
        if (typeof se.escalate === 'boolean' && !usedAlias) ev.escalate = se.escalate;
        out[i] = ev;
      }
      return out;
    });

    // stance-mod precompute for each hazard stance
    const storyEventsByHazard = new Map();
    for (const hz of HAZARD_STANCES) {
      const list = baseEvents.map(arr => {
        const out = new Array(arr.length);
        for (let i = 0; i < arr.length; i++) {
          const e = arr[i];
          const o = { ...e };
          o._stanceMod = stanceDifficultyModifier(o, hz);
          out[i] = o;
        }
        return out;
      });
      storyEventsByHazard.set(hz, list);
    }

    STORY_CACHE = { src: stories, baseEvents, storyEventsByHazard, count: stories.length };
    return STORY_CACHE;
  }

  /********************************************************************
   * EVENT EVALUATION (expected values; fast path)
   ********************************************************************/
  function evalEventOnceFast({
    team, facilities, equipPurchases,
    hazardStance, artifactStance,
    baseDifficulty,
    nextDiffMod,
    nextArtMod,
    event,
    forceStanceMod,           // number|null
    combatDifficultyMultiplier,
    isImmediateCombat,
  }) {
    const mults = skillMultipliers(facilities);
    const facilityKey = facilityKeyForEvent(event);
    const facilityLevel = facilityKey ? (facilities[facilityKey] || 0) : 0;
    const hasFailSafe = facilityLevel >= 100;
    const rerollBudget = facilityKey ? getFacilityRerollBudget(facilityLevel) : 0;
    const hasReroll = rerollBudget > 0;

    const stanceMod = (forceStanceMod != null) ? forceStanceMod : stanceDifficultyModifier(event, hazardStance);

    const difficultyForCheck = (baseDifficulty * nextDiffMod);
    const scaledDifficulty = difficultyForCheck * stanceMod;

    let pInitSuccess = 0;
    let pInitFail = 0;

    let expectedArtifacts = 0;
    let baseDelay = isImmediateCombat ? 0 : getEventDelaySeconds(event, artifactStance);
    let expectedExtraDelay = 0;

    // damage tracking (mean/var per member)
    const members = team;
    const dmgMean = new Float64Array(4);
    const dmgVar = new Float64Array(4);

    // Artifact reward for this event (uses baseDifficulty, not nextDiffMod) per wgc.js
    const chance = eventArtifactChance(event, equipPurchases, artifactStance);
    const rewardBase = 1 + baseDifficulty * 0.1;
    const eventMult = event.artifactMultiplier || (event.specialty === 'Natural Scientist' ? 2 : 1);
    const reward = rewardBase * eventMult * nextArtMod;

    if (event.type === 'team') {
      const st = teamSkillTotal(members, event.skill, mults);
      const dc = Math.max(0, (40 + difficultyForCheck * 4) * stanceMod);
      const p0 = prob4d20Success(dc - st);
      pInitSuccess = hasFailSafe ? 1 : (hasReroll ? (1 - (1 - p0) * (1 - p0)) : p0);
      pInitFail = 1 - pInitSuccess;

      expectedArtifacts = reward * (pInitSuccess * chance);

      // delay extras
      if (event.skill === 'athletics') expectedExtraDelay += pInitFail * 120;
      if (hazardStance === 'Recon') expectedExtraDelay += pInitFail * 60;
      expectedExtraDelay += carefulExtraDelay(event, artifactStance);

      // damage on fail to all members
      let damageEach = 2 * scaledDifficulty;
      if (event.skill === 'wit') damageEach *= 0.5;
      if (damageEach > 0) {
        const p = pInitFail;
        const dv = damageEach * damageEach;
        for (let i = 0; i < 4; i++) {
          dmgMean[i] = p * damageEach;
          dmgVar[i] = p * (1 - p) * dv;
        }
      }
    } else if (event.type === 'combat') {
      const st = combatSkillTotal(members, mults);
      const cm = combatDifficultyMultiplier || 1;
      const dc = Math.max(0, (40 * cm + 4 * difficultyForCheck) * stanceMod);
      const p0 = prob4d20Success(dc - st);
      pInitSuccess = hasFailSafe ? 1 : (hasReroll ? (1 - (1 - p0) * (1 - p0)) : p0);
      pInitFail = 1 - pInitSuccess;

      expectedArtifacts = reward * (pInitSuccess * chance);

      if (hazardStance === 'Recon') expectedExtraDelay += pInitFail * 60;
      expectedExtraDelay += carefulExtraDelay(event, artifactStance);

      const damageEach = Math.max(0, 5 * scaledDifficulty);
      if (damageEach > 0) {
        const p = pInitFail;
        const dv = damageEach * damageEach;
        for (let i = 0; i < 4; i++) {
          dmgMean[i] = p * damageEach;
          dmgVar[i] = p * (1 - p) * dv;
        }
      }
    } else if (event.type === 'science') {
      const leader = members[0];
      let roller = null;
      for (let i = 0; i < 4; i++) {
        const m = members[i];
        if (m && m.classType === event.specialty) { roller = m; break; }
      }
      if (!roller) roller = leader;
      const leaderIsRoller = roller === leader;
      const baseSkill = applyMult(roller ? roller.wit : 0, 'wit', mults);
      const leaderBonus = leaderIsRoller ? 0 : (leader ? applyMult(leader.wit, 'wit', mults) / 2 : 0);
      const st = baseSkill + leaderBonus;
      const dc = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
      const p0 = prob1d20Success(dc - st);
      pInitSuccess = hasFailSafe ? 1 : (hasReroll ? (1 - (1 - p0) * (1 - p0)) : p0);
      pInitFail = 1 - pInitSuccess;

      expectedArtifacts = reward * (pInitSuccess * chance);

      if (hazardStance === 'Recon') expectedExtraDelay += pInitFail * 60;
      expectedExtraDelay += carefulExtraDelay(event, artifactStance);
      // science has no damage
    } else if (event.type === 'individual') {
      const leader = members[0];
      let pool = members;
      if (event.skill === 'athletics') pool = pickAthleticsPool(members);
      const pSelect = 1 / pool.length;

      // Damage on initial fail to selected member
      let dmg = 5 * scaledDifficulty;
      if (event.skill === 'power') dmg *= 2;
      if (event.skill === 'wit') dmg *= 0.5;
      dmg = Math.max(0, dmg);

      let pFailAvg = 0;
      let pFinal20 = 0;
      let pInitSuccessNonCritAvg = 0;

      for (let pi = 0; pi < pool.length; pi++) {
        const m = pool[pi];

        const baseSkill = applyMult(m[event.skill], event.skill, mults);
        const leaderBonus = leader ? applyMult(leader[event.skill], event.skill, mults) / 2 : 0;
        const st = baseSkill + leaderBonus;

        const dc = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
        const p0 = prob1d20Success(dc - st);
        const pInitSucc = hasFailSafe ? 1 : (hasReroll ? (1 - (1 - p0) * (1 - p0)) : p0);
        const pInitFailLocal = 1 - pInitSucc;

        // FINAL roll is 20:
        const needed = Math.ceil(dc - st);
        const twentyIsInitSuccess = needed <= 20;
        const pFinalRoll20 = (twentyIsInitSuccess ? (1 / 20) : 0) + ((1 - p0) * (hasReroll ? (1 / 20) : 0));

        pFailAvg += pSelect * pInitFailLocal;
        pFinal20 += pSelect * pFinalRoll20;

        const pInitSuccessNonCrit = pInitSucc - (twentyIsInitSuccess ? pFinalRoll20 : 0);
        pInitSuccessNonCritAvg += pSelect * pInitSuccessNonCrit;

        if (dmg > 0) {
          // only selected member takes damage
          const p = pSelect * pInitFailLocal;
          const dv = dmg * dmg;
          // map to original index
          for (let j = 0; j < 4; j++) {
            if (members[j] === m) {
              dmgMean[j] += p * dmg;
              dmgVar[j] += p * (1 - p) * dv;
              break;
            }
          }
        }
      }

      pInitFail = pFailAvg;
      pInitSuccess = 1 - pInitFail;

      expectedArtifacts = reward * (pFinal20 + pInitSuccessNonCritAvg * chance);

      if (hazardStance === 'Recon') expectedExtraDelay += pInitFail * 60;
      expectedExtraDelay += carefulExtraDelay(event, artifactStance);
    } else {
      // unknown -> treat like harmless 60s tick
      pInitSuccess = 1;
      pInitFail = 0;
      expectedArtifacts = reward * chance;
      expectedExtraDelay += carefulExtraDelay(event, artifactStance);
    }

    // transitions for next modifiers
    let t0_p = 1, t0_d = 1, t0_a = 1, t1_p = 0, t1_d = 1, t1_a = 1;
    if (event.type === 'team' && event.skill === 'athletics') {
      t0_p = pInitSuccess; t0_d = 0.75; t0_a = 1;
      t1_p = pInitFail;    t1_d = 1;    t1_a = 1;
    } else if (event.type === 'team' && event.skill === 'wit') {
      t0_p = pInitSuccess; t0_d = 1; t0_a = 2;
      t1_p = pInitFail;    t1_d = 1; t1_a = 0.5;
    } else {
      t0_p = 1; t0_d = 1; t0_a = 1;
      t1_p = 0;
    }

    return {
      expectedArtifacts,
      baseDelay,
      expectedExtraDelay,
      dmgMean,
      dmgVar,
      pInitFail,
      trans2: { t0_p, t0_d, t0_a, t1_p, t1_d, t1_a },
    };
  }

  /********************************************************************
   * STORY EVALUATION (FAST DP using fixed arrays)
   ********************************************************************/
  // State index:
  //  baseIndex 0..10, phase 0..1, diffIdx 0..1 (1 or 0.75), artIdx 0..2 (1,2,0.5) => 11*2*2*3=132
  const STATE_SIZE = 11 * 2 * 2 * 3;
  function sIdx(baseIndex, phase, diffIdx, artIdx) {
    return (((baseIndex * 2 + phase) * 2 + diffIdx) * 3 + artIdx) | 0;
  }
  function diffFromIdx(i) { return NEXT_DIFF[i] || 1; }
  function artFromIdx(i) { return NEXT_ART[i] || 1; }
  function idxFromDiff(v) { return (v === 0.75) ? 1 : 0; }
  function idxFromArt(v) { return (v === 2) ? 1 : (v === 0.5 ? 2 : 0); }

  function evaluateStoryFast(storyEvents, ctx) {
    // ctx: { team, facilities, equipPurchases, hazardStance, artifactStance, difficulty }
    const p = new Float64Array(STATE_SIZE);
    const timeW = new Float64Array(STATE_SIZE);
    const lastW = new Float64Array(STATE_SIZE);

    const pN = new Float64Array(STATE_SIZE);
    const timeWN = new Float64Array(STATE_SIZE);
    const lastWN = new Float64Array(STATE_SIZE);

    // damage accumulators (per member)
    const dmgMeanW = new Float64Array(4);
    const dmgVarW = new Float64Array(4);

    let artW = 0;
    let endP = 0;
    let endLastW = 0;

    // start state: before event 0 at time 60
    const start = sIdx(0, 0, 0, 0);
    p[start] = 1;
    timeW[start] = 60;
    lastW[start] = 0;

    // iterate layers (max events + inserted combats)
    for (let iter = 0; iter < 40; iter++) {
      let any = false;

      // clear next arrays
      pN.fill(0); timeWN.fill(0); lastWN.fill(0);

      for (let baseIndex = 0; baseIndex <= 10; baseIndex++) {
        for (let phase = 0; phase <= 1; phase++) {
          for (let diffIdx = 0; diffIdx <= 1; diffIdx++) {
            for (let artIdx = 0; artIdx <= 2; artIdx++) {
              const si = sIdx(baseIndex, phase, diffIdx, artIdx);
              const mass = p[si];
              if (mass <= 0) continue;

              // terminal: baseIndex>=10 and phase=0
              if (baseIndex >= 10 && phase === 0) {
                endP += mass;
                endLastW += lastW[si];
                continue;
              }

              const curTime = timeW[si] / mass;

              if (phase === 1) {
                // inserted combat (after Social Science failure)
                const combatEv = { name: 'Combat challenge', type: 'combat' };
                const evRes = evalEventOnceFast({
                  team: ctx.team, facilities: ctx.facilities, equipPurchases: ctx.equipPurchases,
                  hazardStance: ctx.hazardStance, artifactStance: ctx.artifactStance,
                  baseDifficulty: ctx.difficulty,
                  nextDiffMod: 1, nextArtMod: 1,
                  event: combatEv,
                  // stance mod NOT applied for inserted combat (quirk)
                  forceStanceMod: 1,
                  combatDifficultyMultiplier: 1.25,
                  isImmediateCombat: false,
                });

                artW += mass * evRes.expectedArtifacts;
                for (let i = 0; i < 4; i++) {
                  dmgMeanW[i] += mass * evRes.dmgMean[i];
                  dmgVarW[i] += mass * evRes.dmgVar[i];
                }

                const inc = evRes.baseDelay + evRes.expectedExtraDelay;
                const newTime = curTime + inc;

                const ni = sIdx(baseIndex + 1, 0, 0, 0); // modifiers reset after combat
                pN[ni] += mass;
                timeWN[ni] += mass * newTime;
                lastWN[ni] += mass * curTime;

                any = true;
                continue;
              }

              // base event
              const event = storyEvents[baseIndex];
              if (!event) {
                endP += mass;
                endLastW += lastW[si];
                continue;
              }

              const nextDiffMod = diffFromIdx(diffIdx);
              const nextArtMod = artFromIdx(artIdx);

              const evRes = evalEventOnceFast({
                team: ctx.team, facilities: ctx.facilities, equipPurchases: ctx.equipPurchases,
                hazardStance: ctx.hazardStance, artifactStance: ctx.artifactStance,
                baseDifficulty: ctx.difficulty,
                nextDiffMod, nextArtMod,
                event,
                forceStanceMod: event._stanceMod,
                combatDifficultyMultiplier: 1,
                isImmediateCombat: false,
              });

              artW += mass * evRes.expectedArtifacts;
              for (let i = 0; i < 4; i++) {
                dmgMeanW[i] += mass * evRes.dmgMean[i];
                dmgVarW[i] += mass * evRes.dmgVar[i];
              }

              const inc = evRes.baseDelay + evRes.expectedExtraDelay;
              const newTime = curTime + inc;

              const isSocialScience = (event.type === 'science' && event.specialty === 'Social Scientist');
              const isNaturalEscalate = (event.type === 'science' && event.specialty === 'Natural Scientist' && event.escalate);

              // transitions
              const tr = evRes.trans2;

              // branch 0
              if (tr.t0_p > 0) {
                const m0 = mass * tr.t0_p;
                const nd = idxFromDiff(tr.t0_d);
                const na = idxFromArt(tr.t0_a);

                if (isSocialScience) {
                  // on FAIL, inserted combat; on success, proceed
                  const pFail = evRes.pInitFail;
                  const pToCombat = m0 * pFail;
                  const pToNext = m0 * (1 - pFail);

                  if (pToCombat > 0) {
                    const ni = sIdx(baseIndex, 1, 0, 0); // inserted combat phase
                    pN[ni] += pToCombat;
                    timeWN[ni] += pToCombat * newTime;
                    lastWN[ni] += pToCombat * curTime;
                  }
                  if (pToNext > 0) {
                    const ni = sIdx(baseIndex + 1, 0, 0, 0); // modifiers reset after science
                    pN[ni] += pToNext;
                    timeWN[ni] += pToNext * newTime;
                    lastWN[ni] += pToNext * curTime;
                  }
                } else if (isNaturalEscalate) {
                  // on FAIL, immediate combat (no base delay), but can add recon extra delay
                  const pFail = evRes.pInitFail;
                  if (pFail > 0) {
                    const combatEv = { name: 'Combat challenge', type: 'combat' };
                    const combatRes = evalEventOnceFast({
                      team: ctx.team, facilities: ctx.facilities, equipPurchases: ctx.equipPurchases,
                      hazardStance: ctx.hazardStance, artifactStance: ctx.artifactStance,
                      baseDifficulty: ctx.difficulty,
                      nextDiffMod: 1, nextArtMod: 1,
                      event: combatEv,
                      forceStanceMod: stanceDifficultyModifier(combatEv, ctx.hazardStance),
                      combatDifficultyMultiplier: 1,
                      isImmediateCombat: true,
                    });

                    artW += m0 * pFail * combatRes.expectedArtifacts;
                    for (let i = 0; i < 4; i++) {
                      dmgMeanW[i] += m0 * pFail * combatRes.dmgMean[i];
                      dmgVarW[i] += m0 * pFail * combatRes.dmgVar[i];
                    }

                    const extra = pFail * combatRes.expectedExtraDelay;
                    const ni = sIdx(baseIndex + 1, 0, 0, 0);
                    pN[ni] += m0;
                    timeWN[ni] += m0 * (newTime + extra);
                    lastWN[ni] += m0 * curTime;
                  } else {
                    const ni = sIdx(baseIndex + 1, 0, 0, 0);
                    pN[ni] += m0;
                    timeWN[ni] += m0 * newTime;
                    lastWN[ni] += m0 * curTime;
                  }
                } else {
                  const ni = sIdx(baseIndex + 1, 0, nd, na);
                  pN[ni] += m0;
                  timeWN[ni] += m0 * newTime;
                  lastWN[ni] += m0 * curTime;
                }
              }

              // branch 1 (only used for team athletics/wits)
              if (tr.t1_p > 0) {
                const m1 = mass * tr.t1_p;
                const nd = idxFromDiff(tr.t1_d);
                const na = idxFromArt(tr.t1_a);
                const ni = sIdx(baseIndex + 1, 0, nd, na);
                pN[ni] += m1;
                timeWN[ni] += m1 * newTime;
                lastWN[ni] += m1 * curTime;
              }

              any = true;
            }
          }
        }
      }

      // swap
      p.set(pN);
      timeW.set(timeWN);
      lastW.set(lastWN);

      if (!any) break;
    }

    const denom = endP || 1;
    const expectedArtifacts = artW / denom;
    const expectedLastTime = endLastW / denom || 600;

    const meanDamage = new Float64Array(4);
    const varDamage = new Float64Array(4);
    for (let i = 0; i < 4; i++) {
      meanDamage[i] = dmgMeanW[i] / denom;
      varDamage[i] = dmgVarW[i] / denom;
    }

    return { expectedArtifacts, expectedLastTime, meanDamage, varDamage };
  }

  /********************************************************************
   * PLAN EVALUATION (average over stories)
   ********************************************************************/
  const EVAL_CACHE = new Map(); // key -> result
  const EVAL_CACHE_MAX = 2500;

  function evalCacheGet(key) {
    return EVAL_CACHE.get(key) || null;
  }
  function evalCacheSet(key, val) {
    EVAL_CACHE.set(key, val);
    if (EVAL_CACHE.size > EVAL_CACHE_MAX) {
      // cheap prune: delete ~25%
      let i = 0;
      const target = Math.floor(EVAL_CACHE_MAX * 0.75);
      for (const k of EVAL_CACHE.keys()) {
        EVAL_CACHE.delete(k);
        if (++i >= (EVAL_CACHE_MAX - target)) break;
      }
    }
  }

  function evaluatePlan(team, facilities, equipPurchases, hazardStance, artifactStance, difficulty, sig) {
    const sc = getStoriesPrecomputed();
    if (!sc) return null;

    const key = `${sig}|${hazardStance}|${artifactStance}|d=${difficulty}`;
    const cached = evalCacheGet(key);
    if (cached) return cached;

    const storyLists = sc.storyEventsByHazard.get(hazardStance);
    if (!storyLists) return null;

    let art = 0;
    let lastTime = 0;

    const dmgMean = new Float64Array(4);
    const dmgVar = new Float64Array(4);

    const ctx = {
      team,
      facilities,
      equipPurchases,
      hazardStance,
      artifactStance,
      difficulty,
    };

    for (let si = 0; si < storyLists.length; si++) {
      const r = evaluateStoryFast(storyLists[si], ctx);
      art += r.expectedArtifacts;
      lastTime += r.expectedLastTime;
      for (let i = 0; i < 4; i++) {
        dmgMean[i] += r.meanDamage[i];
        dmgVar[i] += r.varDamage[i];
      }
    }

    const n = storyLists.length;
    const expArtifactsPerOp = art / n;
    const expLastTime = lastTime / n;

    const duration = Math.max(600, expLastTime);

    // Recall probability approx: any member damage >= hp
    let survive = 1;
    for (let i = 0; i < 4; i++) {
      const m = team[i];
      if (!m) continue;
      const mu = dmgMean[i] / n;
      const va = dmgVar[i] / n;
      const sigma = Math.sqrt(Math.max(va, 1e-9));
      const hp = (typeof m.maxHealth === 'number') ? m.maxHealth : (100 + (m.level - 1) * 10);
      const z = (hp - mu) / sigma;
      const pKill = clamp(1 - normCdf(z), 0, 1);
      survive *= (1 - pKill);
    }
    const recallProb = clamp(1 - survive, 0, 1);

    // Healing model
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
    for (let i = 0; i < 4; i++) {
      const m = team[i];
      if (!m) continue;
      const mu = dmgMean[i] / n;
      let deficit = Math.max(0, mu - activeHeal);
      worstDeficit = Math.max(worstDeficit, deficit);
    }
    const leaderHp = team[0] ? ((typeof team[0].maxHealth === 'number') ? team[0].maxHealth : 100) : 100;
    worstDeficit = Math.max(0, worstDeficit - (percent * leaderHp));
    const restTime = idleHealPerSec > 0 ? (worstDeficit / idleHealPerSec) : 0;

    const safeArtifacts = expArtifactsPerOp * (1 - recallProb);
    const cycleTime = duration + restTime;
    const artifactsPerHour = cycleTime > 0 ? (safeArtifacts / cycleTime) * 3600 : 0;

    const score = artifactsPerHour * Math.exp(-CFG.riskAversion * recallProb);

    const out = { score, artifactsPerHour, recallProb, expArtifactsPerOp, duration, restTime };
    evalCacheSet(key, out);
    return out;
  }

  /********************************************************************
   * SEARCH (coarse grid + local refine) - generator, yields often
   ********************************************************************/
  function* optimiseForTeamGen(ctx) {
    const current = clamp(Math.floor(ctx.currentDifficulty || 0), 0, CFG.difficultyMax);
    let bestPlan = null;

    for (let hi = 0; hi < HAZARD_STANCES.length; hi++) {
      const hz = HAZARD_STANCES[hi];
      for (let ai = 0; ai < ARTIFACT_STANCES.length; ai++) {
        const ar = ARTIFACT_STANCES[ai];

        // Coarse sample set (deterministic)
        const samples = [];
        const n = Math.max(3, CFG.searchSamples | 0);
        for (let i = 0; i < n; i++) {
          const d = Math.round((i / (n - 1)) * CFG.difficultyMax);
          samples.push(d);
        }
        samples.push(current);
        samples.sort((a, b) => a - b);
        const uniq = [];
        for (let i = 0; i < samples.length; i++) {
          if (i === 0 || samples[i] !== samples[i - 1]) uniq.push(samples[i]);
        }

        let localBest = null;
        for (let i = 0; i < uniq.length; i++) {
          const d = uniq[i];
          const r = evaluatePlan(ctx.team, ctx.facilities, ctx.equipPurchases, hz, ar, d, ctx.sig);
          yield;
          if (!r) continue;
          if (!localBest || r.score > localBest.r.score) localBest = { d, r };
        }

        if (!localBest) continue;

        // Local refine
        let d = localBest.d;
        let step = Math.max(5, Math.floor(CFG.difficultyMax / (CFG.searchSamples - 1)));
        let curR = localBest.r;

        for (let iter = 0; iter < (CFG.refineIters | 0); iter++) {
          const upD = clamp(d + step, 0, CFG.difficultyMax);
          const dnD = clamp(d - step, 0, CFG.difficultyMax);

          const upR = evaluatePlan(ctx.team, ctx.facilities, ctx.equipPurchases, hz, ar, upD, ctx.sig);
          yield;
          const dnR = evaluatePlan(ctx.team, ctx.facilities, ctx.equipPurchases, hz, ar, dnD, ctx.sig);
          yield;

          let bestHere = { d, r: curR };
          if (upR && upR.score > bestHere.r.score) bestHere = { d: upD, r: upR };
          if (dnR && dnR.score > bestHere.r.score) bestHere = { d: dnD, r: dnR };

          if (bestHere.d === d) {
            step = Math.max(1, Math.floor(step / 2));
          } else {
            d = bestHere.d;
            curR = bestHere.r;
          }
          if (step <= 1) break;
        }

        const candidate = { hazardStance: hz, artifactStance: ar, difficulty: d, metrics: curR };
        if (!bestPlan || candidate.metrics.score > bestPlan.metrics.score) bestPlan = candidate;
      }
    }

    return bestPlan;
  }

  /********************************************************************
   * STATS (kept simple; fast; deterministic)
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
    for (let i = 0; i < raw.length && rem > 0; i++) {
      base[raw[i].k] += 1;
      rem -= 1;
    }
    return base;
  }

  function applyOptimisedStats(team, facilities) {
    const mults = skillMultipliers(facilities);
    for (let i = 0; i < team.length; i++) {
      const m = team[i];
      if (!m || typeof m.respec !== 'function' || typeof m.getPointsToAllocate !== 'function') continue;
      m.respec();
      const pts = m.getPointsToAllocate();
      if (pts <= 0) continue;

      let wP = 1, wA = 1, wW = 1;
      if (m.classType === 'Soldier') {
        wP = 7 * mults.pMult; wA = 2 * mults.aMult; wW = 1 * mults.wMult;
      } else if (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist') {
        wP = 1 * mults.pMult; wA = 2 * mults.aMult; wW = 8 * mults.wMult;
      } else if (m.classType === 'Team Leader') {
        wP = 3 * mults.pMult; wA = 3 * mults.aMult; wW = 4 * mults.wMult;
      }

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
   * SPENDING (unchanged)
   ********************************************************************/
  let trackedSpentArtifacts = 0; // only what THIS script spends
  function getAlienArtifactValue() {
    const gw = getGameWindow();
    const v = gw?.resources?.special?.alienArtifact?.value;
    return (typeof v === 'number') ? v : null;
  }

  function tryAutoBuyWgtEquipment() {
    if (!CFG.autoBuyWgtEquipment) return;
    const wgc = getWGC();
    const gw = getGameWindow();
    if (!wgc || !gw) return;

    const art = gw.resources?.special?.alienArtifact;
    if (!art || typeof art.value !== 'number') return;

    const up = wgc.rdUpgrades?.wgtEquipment;
    if (!up) return;

    while (up.purchases < (up.max || 900)) {
      const cost = (typeof wgc.getUpgradeCost === 'function') ? wgc.getUpgradeCost('wgtEquipment') : (up.purchases + 1);
      if (art.value - cost < CFG.alienArtifactReserve) break;
      const ok = wgc.purchaseUpgrade && wgc.purchaseUpgrade('wgtEquipment');
      if (!ok) break;
      trackedSpentArtifacts += cost;
      logEv('S', cost, Math.round(cost * 1_000_000), 1000, 0);
    }
  }

  function tryAutoUpgradeFacility() {
    if (!CFG.autoUpgradeFacilityWhenReady) return;
    const wgc = getWGC();
    if (!wgc) return;
    if ((wgc.facilityCooldown || 0) > 0) return;

    const candidates = CFG.facilityCandidates
      .filter(k => wgc.facilities && typeof wgc.facilities[k] === 'number' && wgc.facilities[k] < 100);

    if (!candidates.length) return;

    let bestKey = candidates[0];
    let bestLvl = wgc.facilities[bestKey] || 0;
    for (let i = 1; i < candidates.length; i++) {
      const k = candidates[i];
      const lv = wgc.facilities[k] || 0;
      if (lv < bestLvl) { bestLvl = lv; bestKey = k; }
    }

    if (typeof wgc.upgradeFacility === 'function') {
      wgc.upgradeFacility(bestKey);
      logEv('U', 0, 0, 0, 0);
    }
  }

  /********************************************************************
   * PLAN APPLICATION (do not change difficulty mid-run)
   ********************************************************************/
  const planByTeam = new Map();
  const pendingPlanByTeam = new Map();

  function applyPlanToTeam(ti, plan) {
    const wgc = getWGC();
    const gw = getGameWindow();
    if (!wgc || !gw || !plan) return false;

    const op = wgc.operations?.[ti];
    if (op && op.active) {
      pendingPlanByTeam.set(ti, plan);
      return false;
    }

    if (typeof wgc.setStance === 'function') wgc.setStance(ti, plan.hazardStance);
    if (typeof wgc.setArtifactStance === 'function') wgc.setArtifactStance(ti, plan.artifactStance);
    if (op) op.difficulty = plan.difficulty;

    pendingPlanByTeam.delete(ti);

    if (typeof gw.updateWGCUI === 'function') gw.updateWGCUI();
    logEv('A', ti, plan.difficulty, 0, 0);
    return true;
  }

  /********************************************************************
   * SIGNATURE / SNAPSHOT
   ********************************************************************/
  function teamSignature(team, facilities, equip) {
    let s = '';
    for (let i = 0; i < 4; i++) {
      const m = team[i];
      if (!m) { s += 'x|'; continue; }
      s += `${m.classType}:${m.level}:${m.power}:${m.athletics}:${m.wit}|`;
    }
    s += `fac:${facilities.infirmary||0},${facilities.shootingRange||0},${facilities.obstacleCourse||0},${facilities.library||0}|`;
    s += `eq:${equip}`;
    return s;
  }

  function getTeamSnapshot(ti) {
    const wgc = getWGC();
    if (!wgc) return null;
    if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) return null;

    const team = wgc.teams?.[ti];
    if (!Array.isArray(team) || team.length < 4 || team.some(m => !m)) return null;

    const facilities = { ...(wgc.facilities || {}) };
    const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;
    const curDiff = wgc.operations?.[ti]?.difficulty || 0;

    const sig = teamSignature(team, facilities, equip);
    return { ti, team, facilities, equipPurchases: equip, currentDifficulty: curDiff, sig };
  }

  /********************************************************************
   * COOPERATIVE SCHEDULER (prevents freezes)
   ********************************************************************/
  const taskQueue = [];
  let schedulerRunning = false;

  const perf = {
    lastSliceMs: 0,
    evalCount: 0,
    queued: 0,
  };

  function scheduleSlice() {
    if (schedulerRunning) return;
    schedulerRunning = true;

    const run = (deadline) => {
      const start = performance.now();
      const budget = CFG.perfBudgetMs;

      while (taskQueue.length) {
        const t = taskQueue[0];
        let steps = 0;
        while (steps < 200) {
          const r = t.gen.next();
          steps++;
          if (r && r.done) {
            const plan = r.value || null;
            taskQueue.shift();
            if (plan) {
              planByTeam.set(t.ti, { sig: t.sig, plan });
              applyPlanToTeam(t.ti, plan);
            }
            break;
          }
          if ((performance.now() - start) >= budget) break;
        }
        if ((performance.now() - start) >= budget) break;
      }

      perf.lastSliceMs = performance.now() - start;
      perf.queued = taskQueue.length;

      schedulerRunning = false;
      if (taskQueue.length) {
        setTimeout(scheduleSlice, CFG.sliceGapMs);
      }
    };

    if (typeof requestIdleCallback === 'function') {
      requestIdleCallback(run, { timeout: Math.max(25, CFG.perfBudgetMs + CFG.sliceGapMs) });
    } else {
      setTimeout(() => run(null), 0);
    }
  }

  function queueOptimiseTeam(snapshot) {
    if (!snapshot) return;
    for (let i = 0; i < taskQueue.length; i++) {
      if (taskQueue[i].ti === snapshot.ti) return;
    }

    const cached = planByTeam.get(snapshot.ti);
    if (cached && cached.sig === snapshot.sig) return;

    applyOptimisedStats(snapshot.team, snapshot.facilities);

    const ctx = {
      team: snapshot.team,
      facilities: snapshot.facilities,
      equipPurchases: snapshot.equipPurchases,
      currentDifficulty: snapshot.currentDifficulty,
      sig: snapshot.sig,
    };

    const gen = optimiseForTeamGen(ctx);
    taskQueue.push({ ti: snapshot.ti, gen, startedAt: now(), sig: snapshot.sig });
    logEv('C', snapshot.ti, 0, 0, 0);

    scheduleSlice();
  }

  /********************************************************************
   * MANAGER LOOP
   ********************************************************************/
  let lastOptimiseAt = 0;

  function managerTick() {
    if (!CFG.enabled) return;
    const wgc = getWGC();
    const gw = getGameWindow();
    if (!wgc || !gw || !wgc.enabled) return;

    tryAutoBuyWgtEquipment();
    tryAutoUpgradeFacility();

    const tNow = now();

    // apply pending when idle
    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const op = wgc.operations?.[ti];
      const pending = pendingPlanByTeam.get(ti);
      if (pending && op && !op.active) applyPlanToTeam(ti, pending);
    }

    // start idle teams
    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const team = wgc.teams?.[ti];
      if (!Array.isArray(team) || team.some(m => !m)) continue;

      const op = wgc.operations?.[ti];
      if (!op || op.active) continue;

      const snap = getTeamSnapshot(ti);
      if (!snap) continue;

      const cached = planByTeam.get(ti);
      if (!cached || cached.sig !== snap.sig) {
        queueOptimiseTeam(snap);
        logEv('Q', ti, 0, 0, 0);
        continue;
      }

      if (!teamReady(team)) {
        logEv('Q', ti, Math.round(getHpRatio(team[0]) * 100), 0, 0);
        continue;
      }

      applyPlanToTeam(ti, cached.plan);

      if (typeof wgc.startOperation === 'function') {
        wgc.startOperation(ti, cached.plan.difficulty);
        logEv('T', ti, Math.round(getHpRatio(team[0]) * 100), 0, cached.plan.difficulty);
        if (typeof gw.updateWGCUI === 'function') gw.updateWGCUI();
      }
    }

    if ((tNow - lastOptimiseAt) >= CFG.optimiseEveryMs) {
      lastOptimiseAt = tNow;
      logEv('Z', 0, 0, 0, 0);
      for (let ti = 0; ti < 4; ti++) {
        const snap = getTeamSnapshot(ti);
        if (!snap) continue;
        queueOptimiseTeam(snap);
      }
    }
  }

  /********************************************************************
   * ARTIFACT TRACKING (actual net/gross per hour)
   ********************************************************************/
  const artSamples = [];
  let lastSampleAt = 0;

  function takeArtSample() {
    const v = getAlienArtifactValue();
    if (v == null) return;
    const ts = now();
    artSamples.push([ts, v, trackedSpentArtifacts]);
    const cutoff = ts - (CFG.window60mMs * 1.2);
    while (artSamples.length && artSamples[0][0] < cutoff) artSamples.shift();
  }

  function rateForWindow(windowMs) {
    const ts = now();
    const v = getAlienArtifactValue();
    if (v == null || artSamples.length < 2) return { net: 0, gross: 0 };
    const cutoff = ts - windowMs;
    let base = null;
    for (let i = 0; i < artSamples.length; i++) {
      if (artSamples[i][0] >= cutoff) { base = artSamples[i]; break; }
    }
    if (!base) base = artSamples[0];
    const dt = (ts - base[0]) / 1000;
    if (dt <= 1) return { net: 0, gross: 0 };
    const dv = v - base[1];
    const ds = trackedSpentArtifacts - base[2];
    const perHour = 3600 / dt;
    return { net: dv * perHour, gross: (dv + ds) * perHour };
  }

  /********************************************************************
   * COMPACT LOGGING
   ********************************************************************/
  const evBuf = [];
  function logEv(code, a = 0, b = 0, c = 0, d = 0) {
    evBuf.push([now(), code, a, b, c, d]);
    if (evBuf.length > CFG.eventLogMax) evBuf.splice(0, evBuf.length - CFG.eventLogMax);
  }

  function buildTeamSummary() {
    const wgc = getWGC();
    if (!wgc) return [];
    const out = [];
    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const op = wgc.operations?.[ti];
      const team = wgc.teams?.[ti];
      if (!Array.isArray(team)) continue;

      const cached = planByTeam.get(ti)?.plan || null;
      const hp = team[0] ? Math.round(getHpRatio(team[0]) * 100) : 0;

      out.push([
        ti,
        op?.active ? 1 : 0,
        op?.difficulty || 0,
        0,
        wgc.stances?.[ti]?.hazard || 'Neutral',
        wgc.stances?.[ti]?.artifact || 'Neutral',
        hp,
        cached ? [cached.hazardStance, cached.artifactStance, cached.difficulty,
          cached.metrics?.artifactsPerHour || 0, cached.metrics?.recallProb || 0] : null,
        pendingPlanByTeam.has(ti) ? 1 : 0,
      ]);
    }
    return out;
  }

  function cfgCompact() {
    return {
      e: CFG.enabled ? 1 : 0,
      md: CFG.minDeployHpRatio,
      ra: CFG.riskAversion,
      b: CFG.perfBudgetMs,
      y: CFG.sliceGapMs,
      ss: CFG.searchSamples,
      k: CFG.refineIters,
    };
  }

  function dumpLogObject() {
    const v = getAlienArtifactValue();
    const r10 = rateForWindow(CFG.window10mMs);
    const r60 = rateForWindow(CFG.window60mMs);

    let pred = 0;
    for (const v of planByTeam.values()) pred += (v.plan?.metrics?.artifactsPerHour || 0);

    return {
      v: '1.2.3',
      t: now(),
      cfg: cfgCompact(),
      perf: {
        run: 0,
        ms: Math.round(perf.lastSliceMs),
        pc: 4,
        ec: perf.evalCount,
        rq: taskQueue.length,
        pr: pred,
      },
      art: {
        vu: (typeof v === 'number') ? v : null,
        sc: 1,
        cf: 0,
        sp: trackedSpentArtifacts,
        n10: r10.net,
        g10: r10.gross,
        n60: r60.net,
        g60: r60.gross,
      },
      tm: buildTeamSummary(),
      ev: evBuf.slice(-CFG.eventLogMax),
    };
  }

  function dumpLog() {
    try { return JSON.stringify(dumpLogObject()); }
    catch (_) { return '{"v":"1.2.3","err":1}'; }
  }


/********************************************************************
 * MINIMAL HUD (non-intrusive, draggable, persistent)
 ********************************************************************/
const HUD_KEY = 'tt_wgc_hud_v1';
let hudEl = null;
let hudMin = false;

function loadHudState() {
  try {
    const raw = localStorage.getItem(HUD_KEY);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) { return null; }
}
function saveHudState(st) {
  try { localStorage.setItem(HUD_KEY, JSON.stringify(st)); } catch (_) {}
}

function ensureHud() {
  if (!CFG.showHud) return;
  if (hudEl && document.contains(hudEl)) return;

  // If the game wipes body, re-attach to documentElement.
  const host = document.body || document.documentElement;
  if (!host) return;

  const st = loadHudState() || {};
  hudMin = (typeof st.min === 'boolean') ? st.min : !!CFG.hudStartMinimized;

  const el = document.createElement('div');
  el.id = 'tt-wgc-hud';
  el.style.cssText = [
    'position:fixed',
    `left:${Number.isFinite(st.x) ? st.x : 12}px`,
    `top:${Number.isFinite(st.y) ? st.y : 12}px`,
    'z-index:2147483647',
    'background:rgba(18,22,30,0.90)',
    'color:#e8eefc',
    'border:1px solid rgba(255,255,255,0.14)',
    'border-radius:12px',
    'box-shadow:0 12px 40px rgba(0,0,0,0.45)',
    'font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif',
    'min-width:220px',
    'max-width:320px',
    'user-select:none',
    'pointer-events:auto',
  ].join(';');

  el.innerHTML = `
    <div id="tt-wgc-hud-hdr" style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;">
      <div style="font-weight:800;letter-spacing:0.2px;flex:1;">WGC</div>
      <button data-act="min" title="Minimise" style="all:unset;cursor:pointer;padding:2px 6px;border-radius:8px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);">—</button>
      <button data-act="copy" title="Copy log" style="all:unset;cursor:pointer;padding:2px 6px;border-radius:8px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);">Copy</button>
      <button data-act="hide" title="Hide HUD" style="all:unset;cursor:pointer;padding:2px 6px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);">×</button>
    </div>
    <div id="tt-wgc-hud-body" style="padding:8px 10px;border-top:1px solid rgba(255,255,255,0.10);"></div>
  `;

  // Stop the game from seeing pointer events.
  ['pointerdown','pointerup','pointermove','mousedown','mouseup','mousemove','click','wheel'].forEach(evt => {
    el.addEventListener(evt, (e) => { e.stopPropagation(); }, { capture: true });
  });

  // Drag handle
  const hdr = el.querySelector('#tt-wgc-hud-hdr');
  let drag = null;

  hdr.addEventListener('pointerdown', (e) => {
    // Only start drag when pressing on the header, not buttons.
    const t = e.target;
    if (t && t.closest && t.closest('button')) return;

    hdr.style.cursor = 'grabbing';
    hdr.setPointerCapture(e.pointerId);

    const rect = el.getBoundingClientRect();
    drag = { id: e.pointerId, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
    e.preventDefault();
  });

  hdr.addEventListener('pointermove', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    const vw = window.innerWidth || 800;
    const vh = window.innerHeight || 600;

    const w = el.offsetWidth || 260;
    const h = el.offsetHeight || 80;

    let x = e.clientX - drag.ox;
    let y = e.clientY - drag.oy;

    if (CFG.hudAllowAlmostOffscreen) {
      const m = 24;
      x = clamp(x, -w + m, vw - m);
      y = clamp(y, -h + m, vh - m);
    } else {
      x = clamp(x, 0, Math.max(0, vw - w));
      y = clamp(y, 0, Math.max(0, vh - h));
    }

    el.style.left = `${x}px`;
    el.style.top = `${y}px`;
  });

  hdr.addEventListener('pointerup', (e) => {
    if (!drag || drag.id !== e.pointerId) return;
    hdr.style.cursor = 'grab';
    try { hdr.releasePointerCapture(e.pointerId); } catch (_) {}
    drag = null;
    persistHudPos();
  });

  function persistHudPos() {
    const rect = el.getBoundingClientRect();
    const cur = loadHudState() || {};
    cur.x = Math.round(rect.left);
    cur.y = Math.round(rect.top);
    cur.min = !!hudMin;
    saveHudState(cur);
  }

  // Buttons
  el.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      const act = btn.getAttribute('data-act');
      if (act === 'min') {
        hudMin = !hudMin;
        persistHudPos();
        updateHud();
      } else if (act === 'copy') {
        const txt = dumpLog();
        try {
          await navigator.clipboard.writeText(txt);
          btn.textContent = 'Copied';
          setTimeout(() => { btn.textContent = 'Copy'; }, 900);
        } catch (_) {
          // Fallback: prompt
          prompt('Copy log:', txt);
        }
      } else if (act === 'hide') {
        CFG.showHud = false;
        persistHudPos();
        el.remove();
        hudEl = null;
      }
      e.preventDefault();
    });
  });

  host.appendChild(el);
  hudEl = el;

  // Reattach if something removes it
  if (!ensureHud._obs) {
    const obs = new MutationObserver(() => {
      if (CFG.showHud && (!hudEl || !document.contains(hudEl))) {
        hudEl = null;
        ensureHud();
      }
    });
    obs.observe(document.documentElement, { childList: true, subtree: true });
    ensureHud._obs = obs;
  }

  updateHud();
}

function updateHud() {
  if (!CFG.showHud) return;
  if (!hudEl || !document.contains(hudEl)) { ensureHud(); }
  if (!hudEl) return;

  const body = hudEl.querySelector('#tt-wgc-hud-body');
  if (!body) return;

  const wgc = getWGC();
  const r10 = rateForWindow(CFG.window10mMs);
  const r60 = rateForWindow(CFG.window60mMs);

  let pred = 0;
  for (const v of planByTeam.values()) pred += (v.plan?.metrics?.artifactsPerHour || 0);

  const q = taskQueue.length;
  const lastMs = Math.round(perf.lastSliceMs);
  const evals = perf.evalCount;

  const teams = buildTeamSummary();
  const active = teams.reduce((s, t) => s + (t[1] ? 1 : 0), 0);

  if (hudMin) {
    body.style.display = 'none';
    hudEl.style.minWidth = '170px';
    hudEl.querySelector('#tt-wgc-hud-hdr').querySelector('div').textContent =
      `WGC • ${active} active • ${Math.round(r60.gross)}g/hr`;
    return;
  } else {
    body.style.display = 'block';
    hudEl.style.minWidth = '220px';
    hudEl.querySelector('#tt-wgc-hud-hdr').querySelector('div').textContent = 'WGC';
  }

  const av = getAlienArtifactValue();
  body.innerHTML = `
    <div style="display:flex;gap:8px;flex-wrap:wrap;opacity:0.95;">
      <div>AA: <b>${(typeof av === 'number') ? av.toFixed(1) : '—'}</b></div>
      <div>10m: <b>${Math.round(r10.gross)}</b>g / <b>${Math.round(r10.net)}</b>n hr</div>
      <div>60m: <b>${Math.round(r60.gross)}</b>g / <b>${Math.round(r60.net)}</b>n hr</div>
    </div>
    <div style="margin-top:6px;opacity:0.88;">
      Pred(sum): <b>${Math.round(pred)}</b>/hr • Queue: <b>${q}</b> • Slice: <b>${lastMs}ms</b> • Evals: <b>${evals}</b>
    </div>
  `;
}

  /********************************************************************
   * PUBLIC API
   ********************************************************************/
  const API = {
    CFG,
    getWGC,
    toggleHud: () => { CFG.showHud = !CFG.showHud; if (CFG.showHud) ensureHud(); else if (hudEl) { hudEl.remove(); hudEl=null; } },
    showHud: () => { CFG.showHud = true; ensureHud(); },
    hideHud: () => { CFG.showHud = false; if (hudEl) { hudEl.remove(); hudEl=null; } },
    forceRecalc: () => {
      lastOptimiseAt = 0;
      logEv('F', 0, 0, 0, 0);
    },
    dumpLog,
    dumpLogObject,
    _debug: { planByTeam, pendingPlanByTeam, taskQueue, evalCache: EVAL_CACHE },
  };
  W.ttWgcOpt = API;

  /********************************************************************
   * BOOT
   ********************************************************************/
  function boot() {
    // HUD is optional (can be disabled via CFG.showHud)
    ensureHud();
    setInterval(() => { try { updateHud(); } catch (_) {} }, CFG.hudUpdateMs);

    takeArtSample();
    setInterval(() => {
      const ts = now();
      if (ts - lastSampleAt >= CFG.sampleEveryMs) {
        lastSampleAt = ts;
        takeArtSample();
      }
    }, 1000);

    setInterval(() => {
      try { managerTick(); }
      catch (e) { /* silent */ }
    }, 1000);

    setTimeout(() => { lastOptimiseAt = 0; }, 1500);
  }

  const wait = setInterval(() => {
    const wgc = getWGC();
    const sc = getStoriesPrecomputed();
    if (wgc && sc) {
      clearInterval(wait);
      boot();
    }
  }, 300);
})();
