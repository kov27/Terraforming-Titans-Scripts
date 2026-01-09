// ==UserScript==
// @name         Auto TT
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts/scripts/autoTT.user.js
// @version      0.0.7
// @description  automation for Terraforming Titans.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  console.log('[autoTT] loaded ✅');

  // Turn an element into a CSS selector we can use later with querySelector()
  function makeSelector(el) {
    // Best: use the nearest parent that has an id (often buttons contain inner spans/divs)
    const withId = el.id ? el : el.closest?.('[id]');
    if (withId && withId.id) return `#${CSS.escape(withId.id)}`;

    // Fallback: tag + first class (useful for exploring, but not always stable)
    const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
    const firstClass = el.classList?.length ? `.${CSS.escape(el.classList[0])}` : '';
    return tag + firstClass;
  }

  // Alt+Click anything to log what it is
  document.addEventListener(
    'click',
    (e) => {
      if (!e.altKey) return;

      const el = e.target;
      const selector = makeSelector(el);

      const text = (el.textContent || '')
        .trim()
        .replace(/\s+/g, ' ')
        .slice(0, 80);

      console.log('[autoTT PICK]', {
        selector,
        tag: el.tagName?.toLowerCase() || null,
        id: el.id || null,
        classes: el.className || null,
        textPreview: text || null,
      }, el);

      // Optional: Alt+Shift+Click copies the selector to clipboard
      if (e.shiftKey) {
        navigator.clipboard.writeText(selector).then(
          () => console.log('[autoTT] copied:', selector),
          () => console.log('[autoTT] copy failed (browser blocked it):', selector)
        );
      }

      // Stop the game also handling this click
      e.preventDefault();
      e.stopPropagation();
    },
    true // capture phase helps if the game consumes clicks
  );
})();
