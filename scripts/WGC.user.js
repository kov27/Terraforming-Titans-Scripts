// ==UserScript==
// @name         TT - WGC Optimiser & Manager (Stability Fix)
// @namespace    tt-wgc
// @version      1.2.4-fix
// @description  Fixes HUD drag, idle-team deployment, keep-going checkbox handling, and tick reliability.
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        none
// @noframes
// ==/UserScript==

(() => {
  'use strict';

  const CFG = {
    enabled: true,

    // Start teams automatically when idle & above this HP ratio:
    minDeployHpRatio: 0.98,

    // “Keep going once I press it” checkbox:
    // false = leave unchecked (recommended)
    // true  = check it (team stays deployed and chains ops)
    keepGoing: false,

    // How often to manage teams (ms)
    tickMs: 60_000,

    // HUD placement
    hudDefault: { x: 12, y: 12 },
    hudGrip: 20, // keep at least 20px visible so it can be grabbed back
  };

  // Exposed API for you
  const API = {
    CFG,
    getWGC: () => window.warpGateCommand || null,
    dumpLog,
    showHud: () => { if (hud) hud.style.display = ''; },
    hideHud: () => { if (hud) hud.style.display = 'none'; },
    forceTick: () => safeTick(true),
  };
  window.ttWgcOpt = API;

  // ---------------------------------------------------------------------------
  // LOGGING (compact)
  // ---------------------------------------------------------------------------
  const LOG = {
    v: '1.2.4-fix',
    t: Date.now(),
    cfg: {},
    perf: { ticks: 0, lastMs: 0 },
    art: { aa: 0, ta: 0, n10: 0, n60: 0 },
    tm: [],
    ev: []
  };

  const artSamples = []; // [ts, alienArtifactValue, totalArtifacts]
  function sampleArtifacts(wgc) {
    const ts = Date.now();
    const aa = window.resources?.special?.alienArtifact?.value ?? 0;
    const ta = wgc?.totalArtifacts ?? 0;
    artSamples.push([ts, aa, ta]);
    while (artSamples.length && (ts - artSamples[0][0]) > 3.7e6) artSamples.shift(); // keep ~62m
    const rate = (ms) => {
      const cut = ts - ms;
      const a = [...artSamples].reverse().find(x => x[0] <= cut);
      if (!a) return 0;
      const dt = (ts - a[0]) / 3600000;
      const dta = ta - a[2];
      return dt > 0 ? dta / dt : 0;
    };
    LOG.art = { aa, ta, n10: rate(600000), n60: rate(3600000) };
  }

  function pushEv(code, team, a=0, b=0, c=0) {
    LOG.ev.push([Date.now(), code, team|0, a|0, b|0, c|0]);
    if (LOG.ev.length > 250) LOG.ev.shift();
  }

  function dumpLog() {
    LOG.t = Date.now();
    LOG.cfg = {
      e: CFG.enabled ? 1 : 0,
      hp: CFG.minDeployHpRatio,
      kg: CFG.keepGoing ? 1 : 0,
      tick: CFG.tickMs
    };
    return JSON.stringify(LOG);
  }

  // ---------------------------------------------------------------------------
  // READY CHECK
  // ---------------------------------------------------------------------------
  function teamReady(team) {
    if (!team || !team.length) return false;
    for (const m of team) {
      if (!m) return false;
      const hp = (m.health ?? 0);
      const mhp = (m.maxHealth ?? 0);
      if (mhp <= 0) return false;
      if ((hp / mhp) < CFG.minDeployHpRatio) return false;
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // DOM HELPERS (fallback start + checkbox)
  // ---------------------------------------------------------------------------
  function getTeamCard(teamIndex) {
    // In WGC UI, team cards live in #wgc-team-cards
    const container = document.querySelector('#wgc-team-cards');
    if (!container) return null;
    return container.querySelector(`.team-card[data-team="${teamIndex}"]`) ||
           container.querySelector(`.wgc-team-card[data-team="${teamIndex}"]`) ||
           container.querySelector(`.team-card:nth-child(${teamIndex+1})`) ||
           null;
  }

  function setKeepGoingCheckbox(teamIndex, want) {
    const card = getTeamCard(teamIndex);
    if (!card) return false;
    const cb = card.querySelector('input.wgc-auto-start-checkbox');
    if (!cb) return false;
    if (cb.checked === !!want) return true;
    cb.checked = !!want;
    cb.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  }

  function domClickStart(teamIndex) {
    const card = getTeamCard(teamIndex);
    if (!card) return false;
    const btn = card.querySelector('button.start-button');
    if (!btn) return false;
    btn.click();
    return true;
  }

  // ---------------------------------------------------------------------------
  // APPLY SETTINGS SAFELY (NO RECALL)
  // ---------------------------------------------------------------------------
  function applyIdleSettingsOnly(wgc, teamIndex) {
    const op = wgc.operations?.[teamIndex];
    if (!op) return;

    // Do NOT change anything while active
    if (op.active) return;

    // Keep-going checkbox & op.autoStart state
    op.autoStart = !!CFG.keepGoing;
    setKeepGoingCheckbox(teamIndex, CFG.keepGoing);
  }

  // ---------------------------------------------------------------------------
  // START TEAM (robust)
  // ---------------------------------------------------------------------------
  function startTeam(wgc, teamIndex) {
    const op = wgc.operations?.[teamIndex];
    if (!op || op.active) return false;

    // Ensure keep-going is consistent before starting
    applyIdleSettingsOnly(wgc, teamIndex);

    // Prefer direct method
    if (typeof wgc.startOperation === 'function') {
      const diff = Math.floor(Math.max(0, op.difficulty || 0));
      const ok = wgc.startOperation(teamIndex, diff);
      pushEv(ok ? 'S' : 'F', teamIndex, diff, CFG.keepGoing ? 1 : 0, 0);
      if (ok) return true;
    }

    // DOM fallback
    const ok2 = domClickStart(teamIndex);
    pushEv(ok2 ? 'D' : 'X', teamIndex, 0, 0, 0);
    return ok2;
  }

  // ---------------------------------------------------------------------------
  // MAIN TICK
  // ---------------------------------------------------------------------------
  let lastTick = 0;
  function safeTick(force = false) {
    const t0 = performance.now();
    try {
      if (!CFG.enabled) return;
      const wgc = window.warpGateCommand;
      if (!wgc) return;

      // IMPORTANT FIX: old code bailed if wgc.enabled missing
      if (wgc.enabled === false) return;

      sampleArtifacts(wgc);

      const now = Date.now();
      if (!force && (now - lastTick) < CFG.tickMs) return;
      lastTick = now;

      LOG.perf.ticks += 1;

      LOG.tm = [];
      for (let ti = 0; ti < 4; ti++) {
        if (typeof wgc.isTeamUnlocked === 'function' && !wgc.isTeamUnlocked(ti)) continue;

        const team = wgc.teams?.[ti];
        const op = wgc.operations?.[ti];
        const active = op?.active ? 1 : 0;

        let ready = 0;
        if (team && team.every(m => m)) {
          ready = teamReady(team) ? 1 : 0;
        }

        LOG.tm.push([ti, active, ready, op?.difficulty || 0, op?.autoStart ? 1 : 0]);

        // If idle & ready => start
        if (!active && ready) {
          startTeam(wgc, ti);
        } else {
          // keep checkbox synced when idle
          applyIdleSettingsOnly(wgc, ti);
        }
      }

      // update UI if possible
      if (typeof window.updateWGCUI === 'function') window.updateWGCUI();

    } catch (e) {
      pushEv('E', 9, 0, 0, 0);
    } finally {
      const t1 = performance.now();
      LOG.perf.lastMs = Math.round((t1 - t0) * 10) / 10;
      updateHud();
    }
  }

  // ---------------------------------------------------------------------------
  // HUD (draggable, can go partially offscreen)
  // ---------------------------------------------------------------------------
  let hud, hudHeader;
  let hudPos = loadHudPos() || { ...CFG.hudDefault };
  let dragging = false;
  let dragOff = { x: 0, y: 0 };

  function saveHudPos() {
    localStorage.setItem('tt_wgc_hud_pos', JSON.stringify(hudPos));
  }
  function loadHudPos() {
    try { return JSON.parse(localStorage.getItem('tt_wgc_hud_pos') || 'null'); }
    catch { return null; }
  }
  function clampHud() {
    const w = window.innerWidth;
    const h = window.innerHeight;
    const grip = CFG.hudGrip;

    // allow it off-screen, but keep "grip" visible
    hudPos.x = Math.max(-(hud.offsetWidth - grip), Math.min(w - grip, hudPos.x));
    hudPos.y = Math.max(-(hud.offsetHeight - grip), Math.min(h - grip, hudPos.y));
  }

  function makeHud() {
    hud = document.createElement('div');
    hud.id = 'tt-wgc-hud';
    hud.style.cssText = `
      position:fixed; left:${hudPos.x}px; top:${hudPos.y}px;
      z-index:2147483647;
      background:rgba(10,14,20,0.92);
      border:1px solid rgba(255,255,255,0.14);
      border-radius:10px;
      color:#e8eefc;
      font:12px system-ui, -apple-system, Segoe UI, Roboto, Arial;
      min-width:220px;
      box-shadow:0 10px 30px rgba(0,0,0,0.45);
      user-select:none;
    `;

    hud.innerHTML = `
      <div id="tt-wgc-hud-header" style="
        display:flex; align-items:center; gap:8px;
        padding:6px 8px; cursor:move;
        border-bottom:1px solid rgba(255,255,255,0.10);
      ">
        <b style="flex:1">WGC</b>
        <button id="tt-wgc-copy" style="all:unset;cursor:pointer;padding:2px 8px;border-radius:7px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.12);">Copy</button>
        <button id="tt-wgc-hide" style="all:unset;cursor:pointer;padding:2px 8px;border-radius:7px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);">×</button>
      </div>
      <div id="tt-wgc-body" style="padding:8px; line-height:1.35;"></div>
    `;

    document.body.appendChild(hud);
    hudHeader = hud.querySelector('#tt-wgc-hud-header');

    // Drag ONLY on header (fixes “grabs on hover” and “can’t unclick” issues)
    hudHeader.addEventListener('pointerdown', (e) => {
      dragging = true;
      hudHeader.setPointerCapture(e.pointerId);
      dragOff.x = e.clientX - hudPos.x;
      dragOff.y = e.clientY - hudPos.y;
      e.preventDefault();
    });

    hudHeader.addEventListener('pointermove', (e) => {
      if (!dragging) return;
      hudPos.x = e.clientX - dragOff.x;
      hudPos.y = e.clientY - dragOff.y;
      clampHud();
      hud.style.left = hudPos.x + 'px';
      hud.style.top = hudPos.y + 'px';
      saveHudPos();
    });

    hudHeader.addEventListener('pointerup', () => { dragging = false; });

    hud.querySelector('#tt-wgc-hide').addEventListener('click', () => {
      hud.style.display = 'none';
    });

    hud.querySelector('#tt-wgc-copy').addEventListener('click', async () => {
      const s = dumpLog();
      try {
        await navigator.clipboard.writeText(s);
      } catch {
        prompt('Copy log:', s);
      }
    });

    // Hotkey to restore HUD if you lose it: Alt+W
    window.addEventListener('keydown', (e) => {
      if (e.altKey && e.key.toLowerCase() === 'w') {
        hud.style.display = '';
        hudPos = { ...CFG.hudDefault };
        hud.style.left = hudPos.x + 'px';
        hud.style.top = hudPos.y + 'px';
        saveHudPos();
      }
    });
  }

  function updateHud() {
    if (!hud || hud.style.display === 'none') return;
    const body = hud.querySelector('#tt-wgc-body');
    const a = LOG.art;
    body.innerHTML = `
      <div>AA: <b>${(a.aa ?? 0).toFixed(1)}</b> | Total(WGC): <b>${(a.ta ?? 0).toFixed(0)}</b></div>
      <div>10m: <b>${(a.n10 ?? 0).toFixed(1)}/hr</b> | 60m: <b>${(a.n60 ?? 0).toFixed(1)}/hr</b></div>
      <div>Tick ms: <b>${LOG.perf.lastMs}</b> | ticks: <b>${LOG.perf.ticks}</b></div>
      <div>HP≥${Math.round(CFG.minDeployHpRatio*100)}% | KeepGoing: <b>${CFG.keepGoing ? 'ON' : 'OFF'}</b></div>
    `;
  }

  // ---------------------------------------------------------------------------
  // BOOT
  // ---------------------------------------------------------------------------
  function boot() {
    makeHud();
    updateHud();

    // Run immediately once (so Team 2 at 100% should start quickly)
    safeTick(true);

    // Then run on timer
    setInterval(() => safeTick(false), 1000);

    // The “real” manager cadence
    setInterval(() => safeTick(true), CFG.tickMs);
  }

  const wait = setInterval(() => {
    if (document.body && window.warpGateCommand) {
      clearInterval(wait);
      boot();
    }
  }, 250);

})();
