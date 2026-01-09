// ==UserScript==
// @name         Auto TT
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts/scripts/autoTT.user.js
// @version      0.0.5
// @description  automation for Terraforming Titans.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  console.log('[autoTT] loaded ✅');

  function readTerraformingStats() {
    const el = document.querySelector('#world-terraforming');
    if (!el) {
      console.log('[autoTT] #world-terraforming not found');
      return null;
    }

    const text = el.textContent.trim().replace(/\s+/g, ' ');
    // Example: "Pop: 47.5Q CO2: 0.00 kPa"

    // Capture numbers + suffix letters (K/M/B/T/Q etc) for Pop, and a float for CO2
    const popMatch = text.match(/Pop:\s*([0-9.]+[A-Za-z]?)/);
    const co2Match = text.match(/CO2:\s*([0-9.]+)/);

    const stats = {
      rawText: text,
      pop: popMatch ? popMatch[1] : null,
      co2: co2Match ? Number(co2Match[1]) : null,
    };

    console.log('[autoTT] stats:', stats);
    return stats;
  }

  // Hotkey: press "T" to log stats
  document.addEventListener('keydown', (e) => {
    // ignore when typing in inputs (safe habit)
    const tag = document.activeElement?.tagName?.toLowerCase();
    if (tag === 'input' || tag === 'textarea') return;

    if (e.key.toLowerCase() === 't') {
      readTerraformingStats();
    }
  });
})();

