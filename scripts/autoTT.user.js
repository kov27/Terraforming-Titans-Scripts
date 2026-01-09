// ==UserScript==
// @name         Auto TT
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts/scripts/autoTT.user.js
// @version      0.0.3
// @description  automation for Terraforming Titans.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  console.log('[autoTT] loaded ✅', { url: location.href, readyState: document.readyState });

  // Show iframes (if the game UI is inside one, we need to match that iframe URL too)
  const frames = [...document.querySelectorAll('iframe')].map(f => f.src).filter(Boolean);
  console.log('[autoTT] iframes found:', frames);

  // Attach click listener immediately (no DOMContentLoaded needed)
  document.addEventListener(
    'click',
    (e) => {
      // This should log on ANY click anywhere in this document
      console.log('[autoTT] click detected', {
        alt: e.altKey,
        shift: e.shiftKey,
        ctrl: e.ctrlKey,
        meta: e.metaKey,
        targetTag: e.target?.tagName?.toLowerCase() || null,
        targetId: e.target?.id || null,
      });

      // Only do the "picker" output when Alt is held
      if (!e.altKey) return;

      const el = e.target;
      const selector = el?.id ? `#${CSS.escape(el.id)}` : null;

      console.log('[autoTT] Alt+Click PICK:', {
        selector,
        tag: el?.tagName?.toLowerCase() || null,
        id: el?.id || null,
        classes: el?.className || null,
        text: (el?.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80) || null,
      }, el);
    },
    true // capture phase helps catch clicks before the game eats them
  );
})();
