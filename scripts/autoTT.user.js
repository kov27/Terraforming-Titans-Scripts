// ==UserScript==
// @name         Auto TT
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts/scripts/autoTT.user.js
// @version      0.0.2
// @description  automation for Terraforming Titans.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  console.log('[autoTT] loaded ✅');

  // Build a simple CSS selector for an element.
  // Best case: it has an id, because #id is very reliable.
  function simpleSelector(el) {
    if (!el) return null;

    if (el.id) return `#${CSS.escape(el.id)}`;

    // If no id, fall back to tag + first class (less reliable, but useful for exploration)
    const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
    const firstClass = el.classList && el.classList.length ? `.${CSS.escape(el.classList[0])}` : '';
    return tag + firstClass;
  }

  // Wait until the HTML is loaded before wiring events
  document.addEventListener('DOMContentLoaded', () => {
    console.log('[autoTT] DOM ready ✅');

    // Alt+Click anywhere to inspect what you clicked
    document.addEventListener('click', (e) => {
      if (!e.altKey) return; // only do this when Alt is held

      const el = e.target;

      const info = {
        selector: simpleSelector(el),
        tag: el.tagName?.toLowerCase() || null,
        id: el.id || null,
        classes: el.className || null,
        text: (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || null,
      };

      console.log('[autoTT] Alt+Click picked:', info, el);
    });
  });
})();
