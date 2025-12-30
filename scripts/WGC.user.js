// ==UserScript==
// @name         TT - WGC Optimiser & Manager
// @namespace    tt-wgc-optimizer
// @version      1.0.0
// @description  Deterministic optimiser for WGC: stats, stances, difficulty, optional facilities + wgtEquipment spending.
// @match        *://terraforming.titans/*
// @match        *://*.terraforming.titans/*
// @match        *://*/*terraforming*titans*/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  /********************************************************************
   * SETTINGS (edit these)
   ********************************************************************/
  const CFG = {
    enabled: true,

    // Auto-manage runs:
    // - If a team is idle and all members are >= minDeployHpRatio, the script will apply its plan and start.
    autoStartIdleTeams: true,
    minDeployHpRatio: 0.65,     // 0..1

    // Stat management:
    // - On "Optimise & Apply", respec + allocate now, and set auto-ratios for future points.
    manageStats: true,

    // Upgrades management:
    autoUpgradeFacilityWhenReady: true,
    // Consider these facilities for upgrade (cooldown-gated):
    facilityCandidates: ['library', 'shootingRange', 'obstacleCourse', 'infirmary'], // omit 'barracks' by default
    // Spend alien artifacts on wgtEquipment:
    autoBuyWgtEquipment: true,
    // Keep at least this many alien artifacts banked
    alienArtifactReserve: 0,

    // Optimisation objective:
    // Maximise long-run Alien Artifacts per real-time hour from WGC.
    objective: 'artifacts_per_hour',

    // Difficulty search bounds
    difficultyMax: 5000,

    // Risk shaping (deterministic penalty using damage mean/variance approximation)
    // Higher values push the optimiser to safer settings automatically.
    riskAversion: 5.0,

    // UI
    panelWidth: 420,
  };

  /********************************************************************
   * GAME ACCESS
   ********************************************************************/
  const W = window;
  const getWGC = () => W.warpGateCommand;

  /********************************************************************
   * WGC CONSTANTS (mirrors wgc.js)
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

  // nextDifficultyModifier can only be 1 or 0.75 (see wgc.js logic)
  const NEXT_DIFF = [1, 0.75];
  // nextArtifactModifier can only be 1, 2, or 0.5 (see wgc.js logic)
  const NEXT_ART = [1, 2, 0.5];

  const baseEventTemplatesByName = (() => {
    const map = Object.create(null);
    for (const evt of BASE_EVENTS) {
      const { aliases, ...template } = evt; // template includes name/type/skill/specialty...
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
   * 4d20 DISTRIBUTION (for team/combat events)
   ********************************************************************/
  const fourD20 = (() => {
    // pmf[sum] = count
    const pmf = new Array(81).fill(0);
    for (let a = 1; a <= 20; a++) for (let b = 1; b <= 20; b++) for (let c = 1; c <= 20; c++) for (let d = 1; d <= 20; d++) {
      pmf[a + b + c + d] += 1;
    }
    const total = Math.pow(20, 4);
    // suffixCDF[sum] = P(X >= sum)
    const suffix = new Array(82).fill(0);
    let running = 0;
    for (let s = 80; s >= 0; s--) {
      running += pmf[s] || 0;
      suffix[s] = running / total;
    }
    return { pmf, suffix };
  })();

  /********************************************************************
   * MATH HELPERS
   ********************************************************************/
  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

  function normCdf(z) {
    // Approx normal CDF via Abramowitz-Stegun erf approximation
    // CDF = 0.5 * (1 + erf(z / sqrt(2)))
    const t = 1 / (1 + 0.3275911 * Math.abs(z));
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const erf = 1 - (((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t) * Math.exp(-z * z);
    const sign = z < 0 ? -1 : 1;
    return 0.5 * (1 + sign * erf);
  }

  function prob1d20Success(dcMinusSkill) {
    // P(roll >= ceil(dcMinusSkill)) where roll ∈ [1..20]
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
    // Mirrors applyStanceDifficulty in wgc.js
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
    // Mirrors getEventDelay in wgc.js
    if (event && event.type === 'science' && event.specialty === 'Natural Scientist') {
      if (artifactStance === 'Careful') return 180;
      if (artifactStance === 'Rapid Extraction') return 30;
    }
    return 60;
  }

  function carefulExtraDelay(event, artifactStance) {
    // Mirrors: if Natural Scientist & Careful => op.nextEvent += 120 (always, even on success)
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
   * TEAM SKILL TOTALS (mirrors resolveEvent in wgc.js)
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
      if (eventSkill === 'wit' && (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist')) {
        contrib *= 1.5;
      }
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
      const v = m.athletics; // IMPORTANT: tie uses raw athletics (wgc.js does that)
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

  /********************************************************************
   * EVENT EVALUATION (deterministic expected value)
   *
   * Important: individual-event "critical success" flips success/artifact AFTER damage + recon-delay would occur.
   * So we model:
   * - pInitSuccess = success after (optional reroll + failsafe), BEFORE critical
   * - pFinalCrit = probability final roll is 20 (one or two tries depending on reroll availability)
   * - pArtifact = pFinalCrit + (pInitSuccessNonCrit)*chance
   ********************************************************************/
  function evalEventOnce({
    team,
    facilities,
    equipPurchases,
    hazardStance,
    artifactStance,
    baseDifficulty,
    nextDiffMod,     // 1 or 0.75
    nextArtMod,      // 1, 2, 0.5 (used for THIS event's artifact reward multiplier)
    event,
    // Special case: inserted combat from Social Science failure does NOT have stanceDifficultyModifier applied (wgc.js bug/quirk)
    forceStanceDifficultyModifier, // number | null
    combatDifficultyMultiplier,    // for inserted combat (1.25) else 1
    isImmediateCombat,             // true => no base delay added for this combat (natural science escalation)
  }) {
    const mults = skillMultipliers(facilities);
    const facilityKey = facilityKeyForEvent(event);
    const facilityLevel = facilityKey ? (facilities[facilityKey] || 0) : 0;
    const hasFailSafe = facilityLevel >= 100;
    const rerollBudget = facilityKey ? getFacilityRerollBudget(facilityLevel) : 0;
    const hasReroll = rerollBudget > 0;

    const stanceMod = (forceStanceDifficultyModifier != null)
      ? forceStanceDifficultyModifier
      : stanceDifficultyModifier(event, hazardStance);

    const difficultyForCheck = (baseDifficulty * nextDiffMod);
    const scaledDifficulty = difficultyForCheck * stanceMod;

    // DC + skill totals
    let dice = 1;
    let dc = 0;
    let skillTotal = 0;

    // For individual: selection matters for both success and damage
    let individualSelection = null; // { weights: [{m, pSelect, p0, pInitSuccess, pInitFail, pFinalRoll20}] }
    let damageEach = 0;            // if team/combat
    let damageOnFail = 0;          // if individual -> computed per member

    if (event.type === 'team') {
      dice = 4;
      skillTotal = teamSkillTotal(team, event.skill, mults);
      dc = Math.max(0, (40 + difficultyForCheck * 4) * stanceMod);

      damageEach = 2 * scaledDifficulty;
      if (event.skill === 'wit') damageEach *= 0.5;
      damageEach = Math.max(0, damageEach);
    } else if (event.type === 'combat') {
      dice = 4;
      skillTotal = combatSkillTotal(team, mults);
      const cm = combatDifficultyMultiplier || 1;
      dc = Math.max(0, (40 * cm + 4 * difficultyForCheck) * stanceMod);

      damageEach = Math.max(0, 5 * scaledDifficulty);
    } else if (event.type === 'science') {
      dice = 1;
      const leader = team[0];
      let roller = team.find(m => m && m.classType === event.specialty);
      if (!roller) roller = leader;
      const leaderIsRoller = roller === leader;

      const baseSkill = applyMult(roller ? roller.wit : 0, 'wit', mults);
      const leaderBonus = leaderIsRoller ? 0 : (leader ? applyMult(leader.wit, 'wit', mults) / 2 : 0);
      skillTotal = baseSkill + leaderBonus;

      dc = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
      // science failures do no damage
    } else if (event.type === 'individual') {
      dice = 1;
      const leader = team[0];

      // determine selection weights
      let pool = team.filter(Boolean);
      if (event.skill === 'athletics') {
        pool = pickAthleticsPool(team);
      }

      const pSelect = 1 / pool.length;
      const entries = [];

      for (const m of pool) {
        const baseSkill = applyMult(m[event.skill], event.skill, mults);
        const leaderBonus = leader ? applyMult(leader[event.skill], event.skill, mults) / 2 : 0;
        const st = baseSkill + leaderBonus;

        const dcLocal = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
        const p0 = prob1d20Success(dcLocal - st);

        // initial success with optional reroll + failsafe
        let pInitSuccess = p0;
        if (hasFailSafe) pInitSuccess = 1;
        else if (hasReroll) pInitSuccess = 1 - Math.pow(1 - p0, 2);

        const pInitFail = 1 - pInitSuccess;

        // probability that FINAL roll is 20:
        // - if no reroll: P(20 and (roll>=needed? doesn’t matter)) = 1/20 if 20 is a possible roll
        // - if reroll: second chance happens only when first roll fails (based on single-roll p0)
        //   (matches wgc.js flow: reroll only on initial fail)
        const needed = Math.ceil(dcLocal - st);
        const first20CountsAsSuccess = (needed <= 20); // if needed > 20 then 20 is still a fail pre-critical
        const pFinalRoll20 = (first20CountsAsSuccess ? (1 / 20) : 0) + ((1 - p0) * (hasReroll ? (1 / 20) : 0));

        entries.push({ m, pSelect, p0, pInitSuccess, pInitFail, pFinalRoll20, dcLocal, skillTotal: st });
      }

      individualSelection = { entries };

      // damage on failure (BEFORE critical flip)
      // wgc.js: damage = 5*scaledDifficulty; power*2; wit*0.5
      let dmg = 5 * scaledDifficulty;
      if (event.skill === 'power') dmg *= 2;
      if (event.skill === 'wit') dmg *= 0.5;
      damageOnFail = Math.max(0, dmg);

      // For individual, dc and skillTotal are per-member; handled above.
    } else {
      // fallback
      dice = 1;
      dc = Math.max(0, (10 + 1.5 * difficultyForCheck) * stanceMod);
      skillTotal = 0;
    }

    // Base single-roll success probability (team/combat/science)
    let p0 = 0;
    if (event.type === 'team' || event.type === 'combat') {
      p0 = prob4d20Success(dc - skillTotal);
    } else if (event.type === 'science') {
      p0 = prob1d20Success(dc - skillTotal);
    }

    // initial success with reroll + failsafe (non-individual)
    let pInitSuccess = 0;
    let pInitFail = 0;

    if (event.type !== 'individual') {
      if (hasFailSafe) pInitSuccess = 1;
      else if (hasReroll) pInitSuccess = 1 - Math.pow(1 - p0, 2);
      else pInitSuccess = p0;
      pInitFail = 1 - pInitSuccess;
    }

    // Artifact expectation
    const chance = eventArtifactChance(event, equipPurchases, artifactStance);
    const rewardBase = 1 + baseDifficulty * 0.1; // IMPORTANT: uses base difficulty, not scaled by nextDiffMod
    const eventMult = event.artifactMultiplier || (event.specialty === 'Natural Scientist' ? 2 : 1);
    const reward = rewardBase * eventMult * nextArtMod;

    let expectedArtifacts = 0;

    if (event.type === 'individual') {
      // chance-based artifacts only on initial success (pre-critical), but critical forces artifact
      let pFinal20 = 0;
      let pInitSuccessWeighted = 0;

      for (const e of individualSelection.entries) {
        pFinal20 += e.pSelect * e.pFinalRoll20;

        // initial success includes cases where final roll is 20 and already success; we need "non-critical initial successes"
        // For our expectation, approximate: non-20 portion = pInitSuccess - P(finalRoll=20 and needed<=20)
        // If needed<=20, any 20 is an initial success; if needed>20, initial success is 0 anyway.
        const needed = Math.ceil(e.dcLocal - e.skillTotal);
        const twentyIsInitSuccess = needed <= 20;
        const pInitSuccessNonCrit = e.pInitSuccess - (twentyIsInitSuccess ? e.pFinalRoll20 : 0);

        pInitSuccessWeighted += e.pSelect * pInitSuccessNonCrit;
      }

      expectedArtifacts = reward * (pFinal20 + pInitSuccessWeighted * chance);
    } else {
      expectedArtifacts = reward * (pInitSuccess * chance);
    }

    // Expected delays added to op.nextEvent (beyond base delay)
    let expectedExtraDelay = 0;

    // Team athletics fail adds +120
    if (event.type === 'team' && event.skill === 'athletics') {
      expectedExtraDelay += pInitFail * 120;
    }
    // Recon: any failure adds +60 (IMPORTANT: based on initial success, before any critical flip; only matters for non-individual too)
    if (hazardStance === 'Recon') {
      if (event.type === 'individual') {
        // individual uses per-member pInitFail
        let pFail = 0;
        for (const e of individualSelection.entries) pFail += e.pSelect * e.pInitFail;
        expectedExtraDelay += pFail * 60;
      } else {
        expectedExtraDelay += pInitFail * 60;
      }
    }

    // Careful natural science adds +120 ALWAYS (regardless success)
    expectedExtraDelay += carefulExtraDelay(event, artifactStance);

    // Expected base delay for THIS event (queued event only)
    const baseDelay = isImmediateCombat ? 0 : getEventDelaySeconds(event, artifactStance);

    // Damage (mean + variance approximation per member)
    const members = team.filter(Boolean);
    const dmgMean = members.map(_ => 0);
    const dmgVar = members.map(_ => 0);

    const maxHealth = members.map(m => m.maxHealth || (100 + (m.level - 1) * 10));

    if (event.type === 'team' || event.type === 'combat') {
      if (damageEach > 0) {
        for (let i = 0; i < members.length; i++) {
          const p = pInitFail; // damage applied on initial fail
          dmgMean[i] += p * damageEach;
          dmgVar[i] += p * (1 - p) * (damageEach * damageEach);
        }
      }
    } else if (event.type === 'individual') {
      if (damageOnFail > 0) {
        // This event only damages the selected member
        // We’ll map pool members into global member index by reference match
        for (const entry of individualSelection.entries) {
          const idx = members.indexOf(entry.m);
          if (idx < 0) continue;
          const p = entry.pSelect * entry.pInitFail; // selection & initial fail
          dmgMean[idx] += p * damageOnFail;
          dmgVar[idx] += p * (1 - p) * (damageOnFail * damageOnFail);
        }
      }
    }

    // Next modifiers (for NEXT queued event), based on initial success for team athletics/wits
    let trans = null;

    if (event.type === 'team' && event.skill === 'athletics') {
      trans = [
        { p: pInitSuccess, nextDiffMod: 0.75, nextArtMod: 1 },
        { p: pInitFail,    nextDiffMod: 1,    nextArtMod: 1 },
      ];
    } else if (event.type === 'team' && event.skill === 'wit') {
      trans = [
        { p: pInitSuccess, nextDiffMod: 1, nextArtMod: 2 },
        { p: pInitFail,    nextDiffMod: 1, nextArtMod: 0.5 },
      ];
    } else {
      // all other events leave next modifiers at 1
      // (science/individual/combat do not set them)
      // note: critical flip does NOT set next modifiers in wgc.js
      trans = [{ p: 1, nextDiffMod: 1, nextArtMod: 1 }];
    }

    // For individual, compute failure probability for recon/damage already; but state transition is always reset.
    // We keep trans above correct.

    return {
      expectedArtifacts,
      baseDelay,
      expectedExtraDelay,
      dmgMean,
      dmgVar,
      maxHealth,
      trans,
      pInitFailNonIndividual: (event.type === 'individual') ? null : pInitFail,
      pInitFailIndividualAvg: (event.type === 'individual')
        ? individualSelection.entries.reduce((s, e) => s + e.pSelect * e.pInitFail, 0)
        : null,
    };
  }

  /********************************************************************
   * STORY EVALUATION WITH INSERTED COMBAT (Social Science failure)
   ********************************************************************/
  function buildStoryEvents(story, hazardStance) {
    const raw = story && Array.isArray(story.events) ? story.events.slice(0, 10) : [];
    const out = [];
    for (const se of raw) {
      const template = baseEventTemplatesByName[se.name] || null;
      if (template) {
        const ev = { ...template };
        const usedAlias = ev.name !== se.name;
        if (se.type && !usedAlias) ev.type = se.type;
        if (se.skill && !usedAlias) ev.skill = se.skill;
        if (se.specialty && !usedAlias) ev.specialty = se.specialty;
        ev._stanceMod = stanceDifficultyModifier(ev, hazardStance);
        out.push(ev);
      } else {
        const ev = {
          name: se.name,
          type: se.type,
          skill: se.skill,
          specialty: se.specialty,
          escalate: !!se.escalate,
        };
        ev._stanceMod = stanceDifficultyModifier(ev, hazardStance);
        out.push(ev);
      }
    }
    return out;
  }

  function evaluateStory({
    storyEvents,
    team,
    facilities,
    equipPurchases,
    hazardStance,
    artifactStance,
    baseDifficulty,
  }) {
    // DP over (baseIndex 0..10, phase 0=base event at idx, 1=inserted combat after idx) and modifier state
    // State mass holds:
    //  - p: probability mass
    //  - timeW: p * E[currentTime(nextEvent)] entering this node
    //  - lastW: p * E[lastEventTime]
    let nodes = new Map();

    function key(bi, phase, d, a) { return `${bi}|${phase}|${d}|${a}`; }
    function addNode(bi, phase, d, a, p, timeW, lastW) {
      if (p <= 0) return;
      const k = key(bi, phase, d, a);
      const cur = nodes.get(k);
      if (!cur) nodes.set(k, { p, timeW, lastW });
      else {
        cur.p += p;
        cur.timeW += timeW;
        cur.lastW += lastW;
      }
    }

    // start: before event 0 at time 60, no last event yet
    addNode(0, 0, 1, 1, 1, 60, 0);

    // accumulators
    let artW = 0; // expected artifacts (weighted)
    const members = team.filter(Boolean);
    const dmgMeanW = new Array(members.length).fill(0);
    const dmgVarW = new Array(members.length).fill(0);
    let lastTimeW = 0;
    let endP = 0;

    // process until we reach terminal nodes: baseIndex===10 and phase===0 (no pending inserted combat)
    for (let safety = 0; safety < 1000; safety++) {
      // collect terminal nodes
      let progressed = false;
      const nextNodes = new Map();

      const setNext = (k, v) => {
        const cur = nextNodes.get(k);
        if (!cur) nextNodes.set(k, v);
        else {
          cur.p += v.p;
          cur.timeW += v.timeW;
          cur.lastW += v.lastW;
        }
      };

      for (const [k, node] of nodes.entries()) {
        const [biS, phaseS, dS, aS] = k.split('|');
        const bi = parseInt(biS, 10);
        const phase = parseInt(phaseS, 10);
        const nextDiffMod = Number(dS);
        const nextArtMod = Number(aS);

        if (bi >= 10 && phase === 0) {
          // terminal: record last time
          endP += node.p;
          lastTimeW += node.lastW;
          continue;
        }

        const curTime = node.timeW / node.p;
        let event = null;

        if (phase === 0) {
          event = storyEvents[bi];
          if (!event) {
            // no event -> treat as terminal
            endP += node.p;
            lastTimeW += node.lastW;
            continue;
          }

          // Evaluate base event
          const evRes = evalEventOnce({
            team, facilities, equipPurchases,
            hazardStance, artifactStance,
            baseDifficulty,
            nextDiffMod, nextArtMod,
            event,
            forceStanceDifficultyModifier: event._stanceMod, // exact, already applied for base events
            combatDifficultyMultiplier: 1,
            isImmediateCombat: false,
          });

          // Add artifacts
          artW += node.p * evRes.expectedArtifacts;

          // Damage mean/var
          for (let i = 0; i < members.length; i++) {
            dmgMeanW[i] += node.p * evRes.dmgMean[i];
            dmgVarW[i] += node.p * evRes.dmgVar[i];
          }

          // Determine if Social Science inserts combat on FAILURE (based on initial fail)
          const isSocialScience = (event.type === 'science' && event.specialty === 'Social Scientist');

          // For each transition branch (from team athletics/wits; otherwise single branch)
          for (const tr of evRes.trans) {
            if (tr.p <= 0) continue;

            // base delay always applies for queued events
            // plus expected extra delay (recon/athletics/careful)
            // IMPORTANT: extra delay depends on success/fail; but evRes.expectedExtraDelay already uses expected fail prob for this node,
            // so we’ll treat it as expectation across outcomes (works because we’re only tracking expected time).
            const inc = evRes.baseDelay + evRes.expectedExtraDelay;

            const pBranch = node.p * tr.p;

            // time update
            const newTime = curTime + inc;
            const newTimeW = pBranch * newTime;

            // last time becomes current event time
            const newLastW = pBranch * curTime;

            if (isSocialScience) {
              // social science: if it FAILS, insert combat next (difficultyMultiplier 1.25, stanceMod NOT applied in wgc.js)
              // We must approximate insertion probability:
              const pFail = (event.type === 'science') ? (1 - (facilities.library >= 100 ? 1 : (getFacilityRerollBudget(facilities.library || 0) > 0
                ? (1 - Math.pow(1 - prob1d20Success((Math.max(0, (10 + 1.5*(baseDifficulty*nextDiffMod)) * event._stanceMod) - ( (() => {
                    const leader = team[0];
                    let roller = team.find(m => m && m.classType === event.specialty);
                    if (!roller) roller = leader;
                    const leaderIsRoller = roller === leader;
                    const mults = skillMultipliers(facilities);
                    const baseSkill = applyMult(roller ? roller.wit : 0, 'wit', mults);
                    const leaderBonus = leaderIsRoller ? 0 : (leader ? applyMult(leader.wit, 'wit', mults) / 2 : 0);
                    return baseSkill + leaderBonus;
                  })() ))) , 2)) : prob1d20Success((Math.max(0, (10 + 1.5*(baseDifficulty*nextDiffMod)) * event._stanceMod) - ( (() => {
                    const leader = team[0];
                    let roller = team.find(m => m && m.classType === event.specialty);
                    if (!roller) roller = leader;
                    const leaderIsRoller = roller === leader;
                    const mults = skillMultipliers(facilities);
                    const baseSkill = applyMult(roller ? roller.wit : 0, 'wit', mults);
                    const leaderBonus = leaderIsRoller ? 0 : (leader ? applyMult(leader.wit, 'wit', mults) / 2 : 0);
                    return baseSkill + leaderBonus;
                  })() )))) )))) : 0;

              // The above is ugly but keeps us faithful without re-running eval internals; we can do better:
              // However, we already have evRes for THIS node; we can’t extract exact pFail for science directly from it.
              // Instead: approximate insertion probability using expected fail probability embedded in evRes.expectedExtraDelay recon part,
              // but that mixes recon/careful. Safer: just compute pFail via a fresh quick roll model:
              // We'll do that below and overwrite pFail.
              // (see rewrite a few lines down)
              void pFail;

              const p0Science = (() => {
                const mults = skillMultipliers(facilities);
                const leader = team[0];
                let roller = team.find(m => m && m.classType === event.specialty);
                if (!roller) roller = leader;
                const leaderIsRoller = roller === leader;
                const baseSkill = applyMult(roller ? roller.wit : 0, 'wit', mults);
                const leaderBonus = leaderIsRoller ? 0 : (leader ? applyMult(leader.wit, 'wit', mults) / 2 : 0);
                const st = baseSkill + leaderBonus;
                const dc = Math.max(0, (10 + 1.5*(baseDifficulty*nextDiffMod)) * event._stanceMod);
                return prob1d20Success(dc - st);
              })();

              const libLvl = facilities.library || 0;
              const hasFailSafe = libLvl >= 100;
              const hasReroll = getFacilityRerollBudget(libLvl) > 0;
              const pSucc = hasFailSafe ? 1 : (hasReroll ? (1 - Math.pow(1 - p0Science, 2)) : p0Science);
              const pFailInsert = 1 - pSucc;

              // Branch to inserted combat with probability pFailInsert; otherwise go to next base event
              // Note: modifiers reset to (1,1) after science events regardless; and inserted combat uses (1,1)
              const pToCombat = pBranch * pFailInsert;
              const pToNext = pBranch * (1 - pFailInsert);

              if (pToCombat > 0) {
                // same baseIndex, phase=1 (inserted combat)
                const nk = key(bi, 1, 1, 1);
                setNext(nk, {
                  p: pToCombat,
                  timeW: (pToCombat / pBranch) * newTimeW,
                  lastW: (pToCombat / pBranch) * newLastW
                });
              }
              if (pToNext > 0) {
                const nk = key(bi + 1, 0, 1, 1);
                setNext(nk, {
                  p: pToNext,
                  timeW: (pToNext / pBranch) * newTimeW,
                  lastW: (pToNext / pBranch) * newLastW
                });
              }
            } else if (event.type === 'science' && event.specialty === 'Natural Scientist' && event.escalate) {
              // Natural science: on FAIL, immediate combat resolves right away (no base delay for that combat)
              // We approximate by adding expected immediate-combat contributions based on failure probability.
              // We’ll compute fail probability for this science event, then add extra combat in expectation.
              const p0Science = (() => {
                const mults = skillMultipliers(facilities);
                const leader = team[0];
                let roller = team.find(m => m && m.classType === event.specialty);
                if (!roller) roller = leader;
                const leaderIsRoller = roller === leader;
                const baseSkill = applyMult(roller ? roller.wit : 0, 'wit', mults);
                const leaderBonus = leaderIsRoller ? 0 : (leader ? applyMult(leader.wit, 'wit', mults) / 2 : 0);
                const st = baseSkill + leaderBonus;
                const dc = Math.max(0, (10 + 1.5*(baseDifficulty*nextDiffMod)) * event._stanceMod);
                return prob1d20Success(dc - st);
              })();

              const libLvl = facilities.library || 0;
              const hasFailSafe = libLvl >= 100;
              const hasReroll = getFacilityRerollBudget(libLvl) > 0;
              const pSucc = hasFailSafe ? 1 : (hasReroll ? (1 - Math.pow(1 - p0Science, 2)) : p0Science);
              const pFail = 1 - pSucc;

              // Expected immediate combat metrics (executed only on fail)
              const combatEv = { name: 'Combat challenge', type: 'combat' };
              const combatRes = evalEventOnce({
                team, facilities, equipPurchases,
                hazardStance, artifactStance,
                baseDifficulty,
                nextDiffMod: 1,
                nextArtMod: 1,
                event: combatEv,
                // IMPORTANT: immediate combat DOES get stanceDifficultyModifier applied in wgc.js
                forceStanceDifficultyModifier: stanceDifficultyModifier(combatEv, hazardStance),
                combatDifficultyMultiplier: 1,
                isImmediateCombat: true,
              });

              // Add expected artifacts/damage from immediate combat scaled by pFail
              artW += pBranch * pFail * combatRes.expectedArtifacts;
              for (let i = 0; i < members.length; i++) {
                dmgMeanW[i] += pBranch * pFail * combatRes.dmgMean[i];
                dmgVarW[i] += pBranch * pFail * combatRes.dmgVar[i];
              }

              // Immediate combat has no base delay, but can add recon fail delay (+60) in expectation via combatRes.expectedExtraDelay
              // combatRes.expectedExtraDelay already includes recon-failure expectation for combat.
              const extraTimeFromCombat = pFail * combatRes.expectedExtraDelay;

              const nk = key(bi + 1, 0, 1, 1);
              setNext(nk, {
                p: pBranch,
                timeW: pBranch * (curTime + inc + extraTimeFromCombat),
                lastW: newLastW
              });
            } else {
              // Normal transition to next base event
              const nk = key(bi + 1, 0, tr.nextDiffMod, tr.nextArtMod);
              setNext(nk, { p: pBranch, timeW: newTimeW, lastW: newLastW });
            }
          }

          progressed = true;
        } else {
          // phase === 1 : inserted combat after Social Science failure
          const combatEv = { name: 'Combat challenge', type: 'combat', difficultyMultiplier: 1.25 };
          const evRes = evalEventOnce({
            team, facilities, equipPurchases,
            hazardStance, artifactStance,
            baseDifficulty,
            nextDiffMod: 1,
            nextArtMod: 1,
            event: combatEv,
            // IMPORTANT: stanceDifficultyModifier is NOT applied to inserted combat in wgc.js (it is missing), so force 1:
            forceStanceDifficultyModifier: 1,
            combatDifficultyMultiplier: 1.25,
            isImmediateCombat: false,
          });

          artW += node.p * evRes.expectedArtifacts;
          for (let i = 0; i < members.length; i++) {
            dmgMeanW[i] += node.p * evRes.dmgMean[i];
            dmgVarW[i] += node.p * evRes.dmgVar[i];
          }

          const inc = evRes.baseDelay + evRes.expectedExtraDelay; // inserted combat is queued => has base delay 60
          const newTime = curTime + inc;
          const newLastW = node.p * curTime;

          // After inserted combat, continue with next base event
          const nk = key(bi + 1, 0, 1, 1);
          setNext(nk, { p: node.p, timeW: node.p * newTime, lastW: newLastW });

          progressed = true;
        }
      }

      nodes = nextNodes;

      if (!progressed) break;
      if (nodes.size === 0) break;
    }

    const expectedArtifacts = artW / (endP || 1);

    const meanDamage = dmgMeanW.map(v => v / (endP || 1));
    const varDamage = dmgVarW.map(v => v / (endP || 1));

    const expectedLastTime = (lastTimeW / (endP || 1)) || 600;

    return {
      expectedArtifacts,
      expectedLastTime,
      meanDamage,
      varDamage,
      members,
    };
  }

  /********************************************************************
   * PLAN EVALUATION (average over all stories)
   ********************************************************************/
  function evaluatePlan(team, facilities, equipPurchases, hazardStance, artifactStance, difficulty) {
    const stories = Array.isArray(W.WGC_OPERATION_STORIES) ? W.WGC_OPERATION_STORIES : null;
    if (!stories || !stories.length) return null;

    // Build all story event lists once per stance (cheap)
    const storyEventLists = stories.map(s => buildStoryEvents(s, hazardStance));

    let art = 0;
    let lastTime = 0;

    const members = team.filter(Boolean);
    const dmgMean = new Array(members.length).fill(0);
    const dmgVar = new Array(members.length).fill(0);

    for (const storyEvents of storyEventLists) {
      const r = evaluateStory({
        storyEvents,
        team,
        facilities,
        equipPurchases,
        hazardStance,
        artifactStance,
        baseDifficulty: difficulty,
      });
      art += r.expectedArtifacts;
      lastTime += r.expectedLastTime;
      for (let i = 0; i < members.length; i++) {
        dmgMean[i] += r.meanDamage[i];
        dmgVar[i] += r.varDamage[i];
      }
    }

    const n = storyEventLists.length;
    const expArtifactsPerOp = art / n;
    const expLastTime = lastTime / n;

    // Operation duration (wgc.js): finish at max(600, time_of_last_event)
    const duration = Math.max(600, expLastTime);

    // Approx recall probability (conservative): chance any member’s total damage exceeds maxHealth
    // Uses normal approximation with mean/variance.
    let recallProb = 0;
    if (members.length) {
      let survive = 1;
      for (let i = 0; i < members.length; i++) {
        const mu = (dmgMean[i] / n);
        const va = (dmgVar[i] / n);
        const sigma = Math.sqrt(Math.max(va, 1e-9));
        const hp = members[i].maxHealth || (100 + (members[i].level - 1) * 10);

        // P(Damage >= hp) ~= 1 - Phi((hp - mu)/sigma)
        const z = (hp - mu) / sigma;
        const pKill = 1 - normCdf(z);
        survive *= (1 - clamp(pKill, 0, 1));
      }
      recallProb = clamp(1 - survive, 0, 1);
    }

    // Healing model: start from full, take expected damage, heal during op at 1/min, then rest at 50/min
    const healMult = 1 + (facilities.infirmary || 0) * 0.01;
    const activeHeal = (duration / 60) * 1 * healMult;
    const idleHealPerSec = (50 / 60) * healMult;

    // Infirmary end-of-op heal: heals lowest ratio member by a percent of max health
    let percent = 0;
    const inf = facilities.infirmary || 0;
    if (inf >= 100) percent = 0.2;
    else if (inf >= 50) percent = 0.15;
    else if (inf >= 25) percent = 0.1;
    else if (inf >= 10) percent = 0.05;

    let worstDeficit = 0;
    for (let i = 0; i < members.length; i++) {
      const hp = members[i].maxHealth || (100 + (members[i].level - 1) * 10);
      const mu = (dmgMean[i] / n);
      let deficit = Math.max(0, mu - activeHeal);
      worstDeficit = Math.max(worstDeficit, deficit);
    }
    worstDeficit = Math.max(0, worstDeficit - (percent * (members[0]?.maxHealth || 100))); // approx: apply to worst

    const restTime = idleHealPerSec > 0 ? (worstDeficit / idleHealPerSec) : 0;

    // Expected artifacts adjusted for recall risk (recall loses the whole op)
    const safeArtifacts = expArtifactsPerOp * (1 - recallProb);

    const cycleTime = duration + restTime;
    const artifactsPerHour = cycleTime > 0 ? (safeArtifacts / cycleTime) * 3600 : 0;

    // Risk penalty
    const score = artifactsPerHour * Math.exp(-CFG.riskAversion * recallProb);

    return {
      score,
      artifactsPerHour,
      recallProb,
      expArtifactsPerOp,
      duration,
      restTime,
    };
  }

  /********************************************************************
   * DIFFICULTY + STANCE OPTIMISATION (deterministic search)
   ********************************************************************/
  function optimiseForTeam(team, facilities, equipPurchases, currentDifficulty) {
    const stories = Array.isArray(W.WGC_OPERATION_STORIES) ? W.WGC_OPERATION_STORIES : null;
    if (!stories || !stories.length) return null;

    let best = null;

    // Pattern search per stance pair
    for (const hz of HAZARD_STANCES) {
      for (const ar of ARTIFACT_STANCES) {
        // start near current diff
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

        // climb
        for (let iter = 0; iter < 40; iter++) {
          const up = evalD(Math.min(CFG.difficultyMax, d + step));
          const dn = evalD(Math.max(0, d - step));

          const bestLocal = [ {d, r:cur}, {d:d+step, r:up}, {d:d-step, r:dn} ]
            .filter(x => x.r)
            .sort((a,b) => (b.r.score - a.r.score))[0];

          if (bestLocal.d === d) {
            if (step <= 1) break;
            step = Math.max(1, Math.floor(step / 2));
          } else {
            d = clamp(bestLocal.d, 0, CFG.difficultyMax);
            cur = bestLocal.r;
          }
        }

        if (!best || cur.score > best.r.score) {
          best = { hazardStance: hz, artifactStance: ar, difficulty: d, r: cur };
        }
      }
    }

    return best;
  }

  /********************************************************************
   * STAT ALLOCATION (deterministic, fast, good in practice)
   *
   * We respec each member, then allocate all points according to class+facility-weighted ratios,
   * and set those ratios as auto settings for future points.
   ********************************************************************/
  function allocationFromWeights(points, wP, wA, wW) {
    const sum = wP + wA + wW;
    if (sum <= 0 || points <= 0) return { power: 0, athletics: 0, wit: 0 };

    const raw = [
      { k: 'power',     v: points * (wP / sum) },
      { k: 'athletics', v: points * (wA / sum) },
      { k: 'wit',       v: points * (wW / sum) },
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
    raw.sort((a,b) => b.frac - a.frac);
    for (let i = 0; i < raw.length && rem > 0; i++) {
      base[raw[i].k] += 1;
      rem -= 1;
    }
    return base;
  }

  function applyOptimisedStats(team, facilities) {
    const mults = skillMultipliers(facilities);

    for (const m of team) {
      if (!m || typeof m.respec !== 'function' || typeof m.getPointsToAllocate !== 'function') continue;

      // Respec to base
      m.respec();

      const pts = m.getPointsToAllocate();
      if (pts <= 0) continue;

      // Class-aware weights (facility-weighted)
      // - Soldiers: power dominates (combat doubles soldier power contribution)
      // - Scientists: wit dominates
      // - Team leader: balanced but wit slightly favoured (wits team success affects artifacts)
      let wP = 1, wA = 1, wW = 1;

      if (m.classType === 'Soldier') {
        wP = 7 * mults.pMult;
        wA = 2 * mults.aMult;
        wW = 1 * mults.wMult;
      } else if (m.classType === 'Natural Scientist' || m.classType === 'Social Scientist') {
        wP = 1 * mults.pMult;
        wA = 2 * mults.aMult;
        wW = 8 * mults.wMult;
      } else if (m.classType === 'Team Leader') {
        wP = 3 * mults.pMult;
        wA = 3 * mults.aMult;
        wW = 4 * mults.wMult;
      }

      const alloc = allocationFromWeights(pts, wP, wA, wW);

      if (typeof m.allocatePoints === 'function') {
        m.allocatePoints(alloc);
      }

      // Set auto-ratios for future points (so it stays optimal as they level)
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
   * APPLY PLAN TO GAME
   ********************************************************************/
  function applyPlan(teamIndex, plan) {
    const wgc = getWGC();
    if (!wgc || !plan) return false;

    if (typeof wgc.setStance === 'function') wgc.setStance(teamIndex, plan.hazardStance);
    if (typeof wgc.setArtifactStance === 'function') wgc.setArtifactStance(teamIndex, plan.artifactStance);

    const op = wgc.operations && wgc.operations[teamIndex];
    if (op) {
      op.difficulty = plan.difficulty;
      op.autoStart = false; // we manage it
    }

    if (typeof W.updateWGCUI === 'function') W.updateWGCUI();
    return true;
  }

  function teamReady(team) {
    return team.every(m => m && m.maxHealth > 0 && (m.health / m.maxHealth) >= CFG.minDeployHpRatio);
  }

  /********************************************************************
   * FACILITY + R&D SPENDING
   ********************************************************************/
  function tryAutoBuyWgtEquipment() {
    const wgc = getWGC();
    if (!wgc || !CFG.autoBuyWgtEquipment) return;

    const art = W.resources?.special?.alienArtifact;
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

    // Evaluate best marginal upgrade by computing global score across unlocked teams
    const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;

    const teams = [];
    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const t = wgc.teams?.[ti];
      if (!Array.isArray(t) || t.some(x => !x)) continue;
      teams.push({ ti, team: t, currentDiff: wgc.operations?.[ti]?.difficulty || 0 });
    }
    if (!teams.length) return;

    const baseFacilities = { ...wgc.facilities };

    const scoreWithFacilities = (fac) => {
      let sum = 0;
      for (const { team, currentDiff } of teams) {
        const plan = optimiseForTeam(team, fac, equip, currentDiff);
        if (!plan) continue;
        sum += plan.r.artifactsPerHour;
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

    if (best.key) {
      wgc.upgradeFacility(best.key);
    }
  }

  /********************************************************************
   * OPTIMISE + APPLY ALL
   ********************************************************************/
  const planCache = new Map(); // teamIndex -> { sig, plan }

  function teamSignature(team, facilities, equip) {
    const members = team.map(m => [m.classType, m.level, m.power, m.athletics, m.wit].join(':')).join('|');
    const fac = ['infirmary','barracks','shootingRange','obstacleCourse','library'].map(k => `${k}=${facilities[k]||0}`).join(',');
    return `${members}||${fac}||equip=${equip}`;
  }

  function optimiseAndApplyTeam(teamIndex) {
    const wgc = getWGC();
    if (!wgc) return null;

    const team = wgc.teams?.[teamIndex];
    if (!Array.isArray(team) || team.some(m => !m)) return null;

    const facilities = { ...(wgc.facilities || {}) };
    const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;

    // Stats first (deterministic)
    if (CFG.manageStats) applyOptimisedStats(team, facilities);

    const curDiff = wgc.operations?.[teamIndex]?.difficulty || 0;
    const sig = teamSignature(team, facilities, equip);

    const cached = planCache.get(teamIndex);
    if (cached && cached.sig === sig) {
      applyPlan(teamIndex, cached.plan);
      return cached.plan;
    }

    const best = optimiseForTeam(team, facilities, equip, curDiff);
    if (!best) return null;

    const plan = {
      hazardStance: best.hazardStance,
      artifactStance: best.artifactStance,
      difficulty: best.difficulty,
      metrics: best.r,
    };

    planCache.set(teamIndex, { sig, plan });
    applyPlan(teamIndex, plan);
    return plan;
  }

  function optimiseAndApplyAll() {
    const wgc = getWGC();
    if (!wgc) return;

    // Spend upgrades first (they affect optimisation)
    tryAutoBuyWgtEquipment();
    tryAutoUpgradeFacility();

    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const team = wgc.teams?.[ti];
      if (!Array.isArray(team) || team.some(m => !m)) continue;
      optimiseAndApplyTeam(ti);
    }

    if (typeof W.updateWGCUI === 'function') W.updateWGCUI();
  }

  /********************************************************************
   * AUTO MANAGER LOOP (does NOT "recompute" unless team signature changed)
   ********************************************************************/
  function autoTick() {
    if (!CFG.enabled) return;
    const wgc = getWGC();
    if (!wgc || !wgc.enabled) return;

    if (CFG.autoBuyWgtEquipment) tryAutoBuyWgtEquipment();
    if (CFG.autoUpgradeFacilityWhenReady) tryAutoUpgradeFacility();

    if (!CFG.autoStartIdleTeams) return;

    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const team = wgc.teams?.[ti];
      if (!Array.isArray(team) || team.some(m => !m)) continue;

      const op = wgc.operations?.[ti];
      if (!op || op.active) continue;

      if (!teamReady(team)) continue;

      const plan = optimiseAndApplyTeam(ti);
      if (!plan) continue;

      // start operation
      wgc.startOperation(ti, plan.difficulty);
      if (typeof W.updateWGCUI === 'function') W.updateWGCUI();
    }
  }

  /********************************************************************
   * UI
   ********************************************************************/
  let panel = null;
  function makePanel() {
    if (panel) return;

    const el = document.createElement('div');
    el.id = 'tt-wgc-opt-panel';
    el.style.cssText = `
      position: fixed;
      right: 12px;
      bottom: 12px;
      width: ${CFG.panelWidth}px;
      z-index: 2147483647;
      background: rgba(18, 22, 30, 0.92);
      color: #e8eefc;
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 12px;
      box-shadow: 0 12px 40px rgba(0,0,0,0.45);
      font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      font-size: 12px;
      padding: 10px;
    `;

    el.innerHTML = `
      <div style="display:flex;gap:8px;align-items:center;margin-bottom:8px;">
        <div style="font-weight:800;flex:1;">WGC Optimiser & Manager</div>
        <label style="display:flex;gap:6px;align-items:center;opacity:0.95;">
          <input id="tt-wgc-enabled" type="checkbox" ${CFG.enabled ? 'checked' : ''}/>
          Enabled
        </label>
      </div>

      <div style="display:flex;gap:8px;flex-wrap:wrap;">
        <button id="tt-wgc-optimise" style="all:unset;cursor:pointer;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.12);">
          Optimise & Apply (All)
        </button>
        <button id="tt-wgc-clearcache" style="all:unset;cursor:pointer;padding:8px 10px;border-radius:10px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);">
          Clear cache
        </button>
      </div>

      <div id="tt-wgc-status" style="margin-top:10px;opacity:0.9;line-height:1.35;"></div>
      <div id="tt-wgc-teams" style="margin-top:10px;display:flex;flex-direction:column;gap:8px;"></div>
    `;

    document.body.appendChild(el);
    panel = el;

    panel.querySelector('#tt-wgc-enabled').addEventListener('change', (e) => {
      CFG.enabled = !!e.target.checked;
      refreshPanel();
    });

    panel.querySelector('#tt-wgc-optimise').addEventListener('click', () => {
      optimiseAndApplyAll();
      refreshPanel();
    });

    panel.querySelector('#tt-wgc-clearcache').addEventListener('click', () => {
      planCache.clear();
      refreshPanel();
    });

    refreshPanel();
  }

  function fmt(x, d=1) {
    if (!Number.isFinite(x)) return '—';
    return x.toFixed(d);
  }

  function refreshPanel() {
    if (!panel) return;
    const wgc = getWGC();
    const status = panel.querySelector('#tt-wgc-status');
    const teamsBox = panel.querySelector('#tt-wgc-teams');

    if (!wgc || !wgc.enabled) {
      status.textContent = 'Waiting for Warp Gate Command… (open/unlock WGC)';
      teamsBox.innerHTML = '';
      return;
    }

    const art = W.resources?.special?.alienArtifact?.value;
    const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;
    const cd = wgc.facilityCooldown || 0;

    status.innerHTML = `
      <div>Alien Artifacts: <b>${Number.isFinite(art) ? fmt(art, 0) : '—'}</b> | wgtEquipment: <b>${equip}</b> | Facility CD: <b>${fmt(cd, 0)}s</b></div>
      <div style="opacity:0.85;">AutoStart idle teams: <b>${CFG.autoStartIdleTeams ? 'ON' : 'OFF'}</b> | Min deploy HP: <b>${fmt(CFG.minDeployHpRatio*100,0)}%</b></div>
    `;

    teamsBox.innerHTML = '';
    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const team = wgc.teams?.[ti];
      if (!Array.isArray(team)) continue;

      const op = wgc.operations?.[ti];
      const name = wgc.teamNames?.[ti] || `Team ${ti+1}`;

      const cached = planCache.get(ti)?.plan || null;

      const line = document.createElement('div');
      line.style.cssText = `
        padding: 8px;
        border-radius: 10px;
        background: rgba(255,255,255,0.06);
        border: 1px solid rgba(255,255,255,0.10);
      `;

      const ready = team.every(m => m) && teamReady(team.filter(Boolean));
      const active = !!op?.active;

      line.innerHTML = `
        <div style="display:flex;gap:8px;align-items:center;">
          <div style="font-weight:800;flex:1;">${name}</div>
          <div style="opacity:0.9;">${active ? '🟩 active' : (ready ? '🟦 ready' : '⬛ resting')}</div>
          <button data-ti="${ti}" class="tt-wgc-opt-one" style="all:unset;cursor:pointer;padding:6px 8px;border-radius:9px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.12);">
            Optimise
          </button>
        </div>
        <div style="margin-top:6px;opacity:0.92;">
          ${cached ? `Plan: <b>${cached.hazardStance}</b> / <b>${cached.artifactStance}</b> / diff <b>${cached.difficulty}</b> | ~<b>${fmt(cached.metrics?.artifactsPerHour,1)}</b>/hr | recall ~<b>${fmt((cached.metrics?.recallProb||0)*100,1)}%</b>`
                   : 'Plan: — (click Optimise)'}
        </div>
      `;

      teamsBox.appendChild(line);
    }

    teamsBox.querySelectorAll('.tt-wgc-opt-one').forEach(btn => {
      btn.addEventListener('click', (e) => {
        const ti = parseInt(e.currentTarget.getAttribute('data-ti'), 10);
        optimiseAndApplyTeam(ti);
        refreshPanel();
      });
    });
  }

  /********************************************************************
   * BOOT
   ********************************************************************/
  function boot() {
    makePanel();

    // Small manager loop: no background “recompute”; only starts idle teams and buys/upgrades if enabled.
    setInterval(() => {
      try {
        autoTick();
        refreshPanel();
      } catch (_) {}
    }, 1000);
  }

  const wait = setInterval(() => {
    const wgc = getWGC();
    if (wgc) {
      clearInterval(wait);
      boot();
    }
  }, 250);

})();
