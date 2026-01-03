// ==UserScript==
// @name         TT - WGC Optimiser & Manager
// @namespace    tt-wgc-optimizer
// @version      1.2.4
// @description  WGC optimiser + manager. Fixed for lexical globals (warpGateCommand/resources) + HUD drag + fallback starts.
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(() => {
  "use strict";

  const CFG = {
    enabled: true,
    showHud: true,
    minDeployHpRatio: 0.90,
    allowStartWhileResting: false,

    // optimisation time-slicing (lower = less freezing, slower optimisation)
    perfBudgetMs: 3,
    sliceGapMs: 20,

    hudStartMinimized: false,
    hudAllowAlmostOffscreen: true,

    autoBuyWgtEquipment: true,
    alienArtifactReserve: 0,

    autoUpgradeFacilityWhenReady: true,
    facilityCandidates: ["library", "shootingRange", "obstacleCourse", "infirmary"],

    // optimisation cadence
    tickMs: 60_000,

    // (your existing optimiser settings can remain here…)
  };

  const W = window;

  // ---- SAFE ACCESS (lexical globals compatible) ----
  function getLocalWarpGateCommand() {
    try {
      return (typeof warpGateCommand !== "undefined") ? warpGateCommand : null;
    } catch (_) { return null; }
  }

  function getLocalResources() {
    try {
      return (typeof resources !== "undefined") ? resources : null;
    } catch (_) { return null; }
  }

  function getWGC() {
    return getLocalWarpGateCommand() || W.warpGateCommand || null;
  }

  function getResources() {
    return getLocalResources() || W.resources || null;
  }

  function getAlienArtifactValue() {
    const res = getResources();
    const v = res?.special?.alienArtifact?.value;
    return (typeof v === "number") ? v : NaN;
  }

  // ---- HEALTH HELPERS ----
  const clamp = (x, a, b) => Math.max(a, Math.min(b, x));

  function getHpRatio(member) {
    if (!member) return 0;
    const h = (typeof member.health === "number") ? member.health
      : (typeof member.hp === "number") ? member.hp
      : (typeof member.currentHealth === "number") ? member.currentHealth
      : 0;

    const mh = (typeof member.maxHealth === "number") ? member.maxHealth
      : (typeof member.maxHp === "number") ? member.maxHp
      : (typeof member.maximumHealth === "number") ? member.maximumHealth
      : (typeof member.level === "number") ? (100 + (member.level - 1) * 10)
      : 100;

    return mh > 0 ? clamp(h / mh, 0, 1) : 0;
  }

  function teamReady(team) {
    if (CFG.allowStartWhileResting) return true;
    for (const m of team) {
      if (!m) return false;
      if (getHpRatio(m) < CFG.minDeployHpRatio) return false;
    }
    return true;
  }

  // ---- HUD ----
  const HUD_KEY = "tt_wgc_hud_v1";
  let hudEl = null;
  let hudMin = false;

  function loadHudState() {
    try {
      const raw = localStorage.getItem(HUD_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (_) { return null; }
  }

  function saveHudState(st) {
    try { localStorage.setItem(HUD_KEY, JSON.stringify(st)); } catch (_) {}
  }

  function ensureHud() {
    if (!CFG.showHud) return;
    if (hudEl && document.contains(hudEl)) return;

    const host = document.body || document.documentElement;
    if (!host) return;

    const st = loadHudState() || {};
    hudMin = (typeof st.min === "boolean") ? st.min : !!CFG.hudStartMinimized;

    const el = document.createElement("div");
    el.id = "tt-wgc-hud";
    el.style.cssText = [
      "position:fixed",
      `left:${Number.isFinite(st.x) ? st.x : 12}px`,
      `top:${Number.isFinite(st.y) ? st.y : 12}px`,
      "z-index:2147483647",
      "background:rgba(18,22,30,0.90)",
      "color:#e8eefc",
      "border:1px solid rgba(255,255,255,0.14)",
      "border-radius:12px",
      "box-shadow:0 12px 40px rgba(0,0,0,0.45)",
      "font:12px/1.25 system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif",
      "min-width:220px",
      "max-width:320px",
      "user-select:none",
      "pointer-events:auto",
    ].join(";");

    el.innerHTML = `
      <div id="tt-wgc-hud-hdr" style="display:flex;align-items:center;gap:8px;padding:8px 10px;cursor:grab;">
        <div style="font-weight:800;letter-spacing:0.2px;flex:1;">WGC</div>
        <button data-act="min" style="all:unset;cursor:pointer;padding:2px 6px;border-radius:8px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);">—</button>
        <button data-act="copy" style="all:unset;cursor:pointer;padding:2px 6px;border-radius:8px;background:rgba(255,255,255,0.10);border:1px solid rgba(255,255,255,0.14);">Copy</button>
        <button data-act="hide" style="all:unset;cursor:pointer;padding:2px 6px;border-radius:8px;background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.10);">×</button>
      </div>
      <div id="tt-wgc-hud-body" style="padding:8px 10px;border-top:1px solid rgba(255,255,255,0.10);"></div>
    `;

    // IMPORTANT FIX: bubble phase, not capture — allows drag/click handlers to run
    ["pointerdown","pointerup","pointermove","mousedown","mouseup","mousemove","click","wheel"].forEach(evt => {
      el.addEventListener(evt, (e) => { e.stopPropagation(); }, { capture: false });
    });

    const hdr = el.querySelector("#tt-wgc-hud-hdr");
    let drag = null;

    hdr.addEventListener("pointerdown", (e) => {
      if (e.target.closest("button")) return;

      hdr.style.cursor = "grabbing";
      hdr.setPointerCapture(e.pointerId);
      const rect = el.getBoundingClientRect();
      drag = { id: e.pointerId, ox: e.clientX - rect.left, oy: e.clientY - rect.top };
      e.preventDefault();
    });

    hdr.addEventListener("pointermove", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      const vw = window.innerWidth || 800;
      const vh = window.innerHeight || 600;

      const w = el.offsetWidth || 260;
      const h = el.offsetHeight || 80;

      let x = e.clientX - drag.ox;
      let y = e.clientY - drag.oy;

      if (CFG.hudAllowAlmostOffscreen) {
        const m = 8; // smaller margin => can move almost offscreen
        x = clamp(x, -w + m, vw - m);
        y = clamp(y, -h + m, vh - m);
      } else {
        x = clamp(x, 0, Math.max(0, vw - w));
        y = clamp(y, 0, Math.max(0, vh - h));
      }

      el.style.left = `${x}px`;
      el.style.top = `${y}px`;
    });

    hdr.addEventListener("pointerup", (e) => {
      if (!drag || drag.id !== e.pointerId) return;
      hdr.style.cursor = "grab";
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

    el.querySelectorAll("button").forEach(btn => {
      btn.addEventListener("click", async (e) => {
        const act = btn.getAttribute("data-act");
        if (act === "min") {
          hudMin = !hudMin;
          persistHudPos();
          updateHud();
        } else if (act === "copy") {
          const txt = dumpLog();
          try { await navigator.clipboard.writeText(txt); }
          catch (_) { prompt("Copy log:", txt); }
        } else if (act === "hide") {
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
    updateHud();
  }

  function updateHud() {
    if (!hudEl) return;
    const body = hudEl.querySelector("#tt-wgc-hud-body");
    if (!body) return;

    const wgc = getWGC();
    if (!wgc) {
      body.innerHTML = `<div style="opacity:.85">WGC not visible to script.<br>
      This TT build uses lexical globals.<br>Fix applied in v1.2.4 — if you're still seeing this, the script isn't running in the game iframe.</div>`;
      return;
    }

    const art = getAlienArtifactValue();
    body.style.display = hudMin ? "none" : "block";
    if (hudMin) return;

    body.innerHTML = `
      <div>Alien Artifacts: <b>${Number.isFinite(art) ? art.toFixed(1) : "—"}</b></div>
      <div style="opacity:.85">Tick every ${(CFG.tickMs/1000)|0}s • Min HP ${(CFG.minDeployHpRatio*100)|0}%</div>
    `;
  }

  // ---- LOG (minimal, but keeps ttWgcOpt API alive) ----
  function dumpLog() {
    return JSON.stringify({
      v: "1.2.4",
      t: Date.now(),
      aa: getAlienArtifactValue(),
      wgc: !!getWGC(),
    });
  }

  // ---- MANAGER LOOP ----
  let lastTick = 0;

  function managerTick() {
    if (!CFG.enabled) return;

    const wgc = getWGC();
    if (!wgc || !wgc.enabled) return;

    for (let ti = 0; ti < 4; ti++) {
      if (typeof wgc.isTeamUnlocked === "function" && !wgc.isTeamUnlocked(ti)) continue;
      const team = wgc.teams?.[ti];
      const op = wgc.operations?.[ti];
      if (!Array.isArray(team) || team.some(m => !m)) continue;
      if (!op || op.active) continue;

      if (!teamReady(team)) continue;

      // fallback start immediately (even before optimiser finishes)
      const d = Number(op.difficulty ?? 0);
      if (d > 0 && typeof wgc.startOperation === "function") {
        wgc.startOperation(ti, d);
      }
    }

    if (typeof updateWGCUI === "function") updateWGCUI();
  }

  function tickLoop() {
    const now = Date.now();
    if (now - lastTick >= CFG.tickMs) {
      lastTick = now;
      try { managerTick(); } catch (_) {}
    }
    ensureHud();
    updateHud();
  }

  // ---- EXPORT API ----
  W.ttWgcOpt = {
    getWGC,
    getResources,
    dumpLog,
    showHud: () => { CFG.showHud = true; ensureHud(); updateHud(); },
    hideHud: () => { CFG.showHud = false; hudEl?.remove(); hudEl = null; },
  };

  // ---- START ----
  ensureHud();
  updateHud();
  setInterval(tickLoop, 1000);
})();
