// ==UserScript==
// @name         Auto TT
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts/scripts/autoTT.user.js
// @version      0.0.6
// @description  automation for Terraforming Titans.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  console.log('[autoTT] loaded ✅');

  function readTerraformingStats() {
    const el = document.querySelector('#world-terraforming');
    if (!el) return null;

    const text = el.textContent.trim().replace(/\s+/g, ' ');
    const popMatch = text.match(/Pop:\s*([0-9.]+[A-Za-z]?)/);
    const co2Match = text.match(/CO2:\s*([0-9.]+)/);

    return {
      rawText: text,
      pop: popMatch ? popMatch[1] : null,
      co2: co2Match ? Number(co2Match[1]) : null,
    };
  }

  // Create a small overlay once
  function createOverlay() {
    const box = document.createElement('div');
    box.id = 'autoTT-overlay';
    box.style.position = 'fixed';
    box.style.top = '10px';
    box.style.left = '10px';
    box.style.zIndex = '999999';
    box.style.padding = '8px 10px';
    box.style.borderRadius = '10px';
    box.style.background = 'rgba(0,0,0,0.75)';
    box.style.color = 'white';
    box.style.font = '12px/1.2 sans-serif';
    box.textContent = 'autoTT: (press T)';

    document.documentElement.appendChild(box);
    return box;
  }

  const overlay = createOverlay();

  function updateOverlay() {
    const stats = readTerraformingStats();
    if (!stats) {
      overlay.textContent = 'autoTT: stats not found';
      return;
    }

    overlay.textContent = `autoTT | Pop: ${stats.pop} | CO2: ${stats.co2} kPa`;
    console.log('[autoTT] stats:', stats);
  }

  // Press "T" to update overlay + log stats
  document.addEventListener('keydown', (e) => {
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (e.key.toLowerCase() === 't') {
      updateOverlay();
    }
  });
})();
