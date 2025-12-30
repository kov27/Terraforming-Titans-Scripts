// ==UserScript==
// @name         TT - WGC Optimiser & Manager
// @namespace    tt-wgc-optimizer
// @version      1.0.1
// @description  Deterministic optimiser for WGC: stats, stances, difficulty, optional facilities + wgtEquipment spending.
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
   * 4d20 DISTRIBUTION (for team/combat events)
   ********************************************************************/
  const fourD20 = (() => {
    const pmf = new Array(81).fill(0);
    for (let a = 1; a <= 20; a++)
      for (let b = 1; b <= 20; b++)
        for (let c = 1; c <= 20; c++)
          for (let d = 1; d <= 20; d++)
            pmf[a + b + c + d] += 1;

    const total = Math.pow(20, 4);
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

  /********************************************************************
   * EVENT EVALUATION (deterministic expected value)
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

    const stanceMod = (forceStanceDifficultyModifier != null)
      ? forceStanceDifficultyModifier
      : stanceDifficultyModifier(event, hazardStance);

    const difficultyForCheck = (baseDifficulty * nextDiffMod);
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

        let pInitSuccess = p0;
        if (hasFailSafe) pInitSuccess = 1;
        else if (hasReroll) pInitSuccess = 1 - Math.pow(1 - p0, 2);

        const pInitFail = 1 - pInitSuccess;

        const needed = Math.ceil(dcLocal - st);
        const first20CountsAsSuccess = (needed <= 20);
        const pFinalRoll20 = (first20CountsAsSuccess ? (1 / 20) : 0) + ((1 - p0) * (hasReroll ? (1 / 20) : 0));

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
    if (event.type === 'team' || event.type === 'combat') {
      p0 = prob4d20Success(dc - skillTotal);
    } else if (event.type === 'science') {
      p0 = prob1d20Success(dc - skillTotal);
    }

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
      let pInitSuccessWeighted = 0;

      for (const e of individualSelection.entries) {
        pFinal20 += e.pSelect * e.pFinalRoll20;

        const needed = Math.ceil(e.dcLocal - e.skillTotal);
        const twentyIsInitSuccess = needed <= 20;
        const pInitSuccessNonCrit = e.pInitSuccess - (twentyIsInitSuccess ? e.pFinalRoll20 : 0);

        pInitSuccessWeighted += e.pSelect * pInitSuccessNonCrit;
      }

      expectedArtifacts = reward * (pFinal20 + pInitSuccessWeighted * chance);
    } else {
      expectedArtifacts = reward * (pInitSuccess * chance);
    }

    let expectedExtraDelay = 0;

    if (event.type === 'team' && event.skill === 'athletics') {
      expectedExtraDelay += pInitFail * 120;
    }

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
    const dmgMean = members.map(_ => 0);
    const dmgVar = members.map(_ => 0);

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
      trans = [{ p: 1, nextDiffMod: 1, nextArtMod: 1 }];
    }

    return {
      expectedArtifacts,
      baseDelay,
      expectedExtraDelay,
      dmgMean,
      dmgVar,
      trans,
      pInitFailNonIndividual: (event.type === 'individual') ? null : pInitFail,
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

    addNode(0, 0, 1, 1, 1, 60, 0);

    let artW = 0;
    const members = team.filter(Boolean);
    const dmgMeanW = new Array(members.length).fill(0);
    const dmgVarW = new Array(members.length).fill(0);
    let lastTimeW = 0;
    let endP = 0;

    for (let safety = 0; safety < 1000; safety++) {
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
          endP += node.p;
          lastTimeW += node.lastW;
          continue;
        }

        const curTime = node.timeW / node.p;

        if (phase === 0) {
          const event = storyEvents[bi];
          if (!event) {
            endP += node.p;
            lastTimeW += node.lastW;
            continue;
          }

          const evRes = evalEventOnce({
            team, facilities, equipPurchases,
            hazardStance, artifactStance,
            baseDifficulty,
            nextDiffMod, nextArtMod,
            event,
            forceStanceDifficultyModifier: event._stanceMod,
            combatDifficultyMultiplier: 1,
            isImmediateCombat: false,
          });

          artW += node.p * evRes.expectedArtifacts;

          for (let i = 0; i < members.length; i++) {
            dmgMeanW[i] += node.p * evRes.dmgMean[i];
            dmgVarW[i] += node.p * evRes.dmgVar[i];
          }

          const isSocialScience = (event.type === 'science' && event.specialty === 'Social Scientist');

          for (const tr of evRes.trans) {
            if (tr.p <= 0) continue;

            const inc = evRes.baseDelay + evRes.expectedExtraDelay;
            const pBranch = node.p * tr.p;

            const newTime = curTime + inc;
            const newTimeW = pBranch * newTime;
            const newLastW = pBranch * curTime;

            if (isSocialScience) {
              const pFailInsert = (evRes.pInitFailNonIndividual != null) ? evRes.pInitFailNonIndividual : 0;

              const pToCombat = pBranch * pFailInsert;
              const pToNext   = pBranch * (1 - pFailInsert);

              if (pToCombat > 0) {
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
              const pFail = (evRes.pInitFailNonIndividual != null) ? evRes.pInitFailNonIndividual : 0;

              const combatEv = { name: 'Combat challenge', type: 'combat' };
              const combatRes = evalEventOnce({
                team, facilities, equipPurchases,
                hazardStance, artifactStance,
                baseDifficulty,
                nextDiffMod: 1,
                nextArtMod: 1,
                event: combatEv,
                forceStanceDifficultyModifier: stanceDifficultyModifier(combatEv, hazardStance),
                combatDifficultyMultiplier: 1,
                isImmediateCombat: true,
              });

              artW += pBranch * pFail * combatRes.expectedArtifacts;
              for (let i = 0; i < members.length; i++) {
                dmgMeanW[i] += pBranch * pFail * combatRes.dmgMean[i];
                dmgVarW[i] += pBranch * pFail * combatRes.dmgVar[i];
              }

              const extraTimeFromCombat = pFail * combatRes.expectedExtraDelay;

              const nk = key(bi + 1, 0, 1, 1);
              setNext(nk, {
                p: pBranch,
                timeW: pBranch * (curTime + inc + extraTimeFromCombat),
                lastW: newLastW
              });
            } else {
              const nk = key(bi + 1, 0, tr.nextDiffMod, tr.nextArtMod);
              setNext(nk, { p: pBranch, timeW: newTimeW, lastW: newLastW });
            }
          }

          progressed = true;
        } else {
          const combatEv = { name: 'Combat challenge', type: 'combat' };
          const evRes = evalEventOnce({
            team, facilities, equipPurchases,
            hazardStance, artifactStance,
            baseDifficulty,
            nextDiffMod: 1,
            nextArtMod: 1,
            event: combatEv,
            forceStanceDifficultyModifier: 1,     // inserted combat: stance mod missing in wgc.js
            combatDifficultyMultiplier: 1.25,     // inserted combat multiplier
            isImmediateCombat: false,
          });

          artW += node.p * evRes.expectedArtifacts;
          for (let i = 0; i < members.length; i++) {
            dmgMeanW[i] += node.p * evRes.dmgMean[i];
            dmgVarW[i] += node.p * evRes.dmgVar[i];
          }

          const inc = evRes.baseDelay + evRes.expectedExtraDelay;
          const newTime = curTime + inc;
          const newLastW = node.p * curTime;

          const nk = key(bi + 1, 0, 1, 1);
          setNext(nk, { p: node.p, timeW: node.p * newTime, lastW: newLastW });

          progressed = true;
        }
      }

      nodes = nextNodes;
      if (!progressed || nodes.size === 0) break;
    }

    const expectedArtifacts = artW / (endP || 1);
    const meanDamage = dmgMeanW.map(v => v / (endP || 1));
    const varDamage = dmgVarW.map(v => v / (endP || 1));
    const expectedLastTime = (lastTimeW / (endP || 1)) || 600;

    return { expectedArtifacts, expectedLastTime, meanDamage, varDamage, members };
  }

  /********************************************************************
   * PLAN EVALUATION (average over all stories)
   ********************************************************************/
  function evaluatePlan(team, facilities, equipPurchases, hazardStance, artifactStance, difficulty) {
    const stories = Array.isArray(W.WGC_OPERATION_STORIES) ? W.WGC_OPERATION_STORIES : null;
    if (!stories || !stories.length) return null;

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

    const duration = Math.max(600, expLastTime);

    let recallProb = 0;
    if (members.length) {
      let survive = 1;
      for (let i = 0; i < members.length; i++) {
        const mu = (dmgMean[i] / n);
        const va = (dmgVar[i] / n);
        const sigma = Math.sqrt(Math.max(va, 1e-9));
        const hp = members[i].maxHealth || (100 + (members[i].level - 1) * 10);

        const z = (hp - mu) / sigma;
        const pKill = 1 - normCdf(z);
        survive *= (1 - clamp(pKill, 0, 1));
      }
      recallProb = clamp(1 - survive, 0, 1);
    }

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
    for (let i = 0; i < members.length; i++) {
      const mu = (dmgMean[i] / n);
      let deficit = Math.max(0, mu - activeHeal);
      worstDeficit = Math.max(worstDeficit, deficit);
    }
    worstDeficit = Math.max(0, worstDeficit - (percent * (members[0]?.maxHealth || 100)));

    const restTime = idleHealPerSec > 0 ? (worstDeficit / idleHealPerSec) : 0;

    const safeArtifacts = expArtifactsPerOp * (1 - recallProb);

    const cycleTime = duration + restTime;
    const artifactsPerHour = cycleTime > 0 ? (safeArtifacts / cycleTime) * 3600 : 0;

    const score = artifactsPerHour * Math.exp(-CFG.riskAversion * recallProb);

    return { score, artifactsPerHour, recallProb, expArtifactsPerOp, duration, restTime };
  }

  /********************************************************************
   * DIFFICULTY + STANCE OPTIMISATION (deterministic search)
   ********************************************************************/
  function optimiseForTeam(team, facilities, equipPurchases, currentDifficulty) {
    const stories = Array.isArray(W.WGC_OPERATION_STORIES) ? W.WGC_OPERATION_STORIES : null;
    if (!stories || !stories.length) return null;

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
          const up = evalD(Math.min(CFG.difficultyMax, d + step));
          const dn = evalD(Math.max(0, d - step));

          const bestLocal = [{ d, r: cur }, { d: d + step, r: up }, { d: d - step, r: dn }]
            .filter(x => x.r)
            .sort((a, b) => (b.r.score - a.r.score))[0];

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
   * STAT ALLOCATION (simple deterministic policy)
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
    raw.sort((a, b) => b.frac - a.frac);
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

      m.respec();

      const pts = m.getPointsToAllocate();
      if (pts <= 0) continue;

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
      op.autoStart = false;
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
  const planCache = new Map();

  function teamSignature(team, facilities, equip) {
    const members = team.map(m => [m.classType, m.level, m.power, m.athletics, m.wit].join(':')).join('|');
    const fac = ['infirmary', 'barracks', 'shootingRange', 'obstacleCourse', 'library'].map(k => `${k}=${facilities[k] || 0}`).join(',');
    return `${members}||${fac}||equip=${equip}`;
  }

  function optimiseAndApplyTeam(teamIndex) {
    const wgc = getWGC();
    if (!wgc) return null;

    const team = wgc.teams?.[teamIndex];
    if (!Array.isArray(team) || team.some(m => !m)) return null;

    const facilities = { ...(wgc.facilities || {}) };
    const equip = wgc.rdUpgrades?.wgtEquipment?.purchases || 0;

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
   * AUTO MANAGER LOOP (no recompute unless team signature changes)
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

  function fmt(x, d = 1) {
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
      <div style="opacity:0.85;">AutoStart idle teams: <b>${CFG.autoStartIdleTeams ? 'ON' : 'OFF'}</b> | Min deploy HP: <b>${fmt(CFG.minDeployHpRatio * 100, 0)}%</b></div>
    `;

    teamsBox.innerHTML = '';
    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;
      const team = wgc.teams?.[ti];
      if (!Array.isArray(team)) continue;

      const op = wgc.operations?.[ti];
      const name = wgc.teamNames?.[ti] || `Team ${ti + 1}`;

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
          ${cached ? `Plan: <b>${cached.hazardStance}</b> / <b>${cached.artifactStance}</b> / diff <b>${cached.difficulty}</b> | ~<b>${fmt(cached.metrics?.artifactsPerHour, 1)}</b>/hr | recall ~<b>${fmt((cached.metrics?.recallProb || 0) * 100, 1)}%</b>`
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
