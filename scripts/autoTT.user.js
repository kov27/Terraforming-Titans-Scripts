// ==UserScript==
// @name         Auto TT
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts/scripts/autoTT.user.js
// @version      0.0.8
// @description  automation for Terraforming Titans.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  console.log('[autoTT] loaded ✅');

  // --------- STEP A: tiny overlay ----------
  const overlay = document.createElement('div');
  overlay.id = 'autoTT-overlay';
  overlay.style.position = 'fixed';
  overlay.style.top = '10px';
  overlay.style.left = '10px';
  overlay.style.zIndex = '999999';
  overlay.style.padding = '8px 10px';
  overlay.style.borderRadius = '10px';
  overlay.style.background = 'rgba(0,0,0,0.75)';
  overlay.style.color = 'white';
  overlay.style.font = '12px/1.25 sans-serif';
  overlay.style.whiteSpace = 'pre';
  overlay.textContent = 'autoTT overlay starting...';
  document.documentElement.appendChild(overlay);

  function textOf(selector) {
    const el = document.querySelector(selector);
    if (!el) return '(missing)';
    return (el.textContent || '').trim().replace(/\s+/g, ' ');
  }

  function updateOverlay() {
    const name = textOf('#metal-name'); // "Metal"
    const amt  = textOf('#metal-resources-container'); // "4.6Sx"
    const cap  = textOf('#metal-cap-resources-container'); // "5.7Sx"
    const pps  = textOf('#metal-pps-resources-container'); // "+31.17Q"

    overlay.textContent =
      `autoTT\n` +
      `${name}: ${amt} / ${cap}\n` +
      `pps: ${pps}\n` +
      `\n(Alt+Click still logs picks)`;
  }

  setInterval(updateOverlay, 500);
  updateOverlay();

  // --------- STEP B: keep your picker ----------
  function makeSelector(el) {
    const withId = el.id ? el : el.closest?.('[id]');
    if (withId && withId.id) return `#${CSS.escape(withId.id)}`;

    const tag = el.tagName ? el.tagName.toLowerCase() : 'unknown';
    const firstClass = el.classList?.length ? `.${CSS.escape(el.classList[0])}` : '';
    return tag + firstClass;
  }

  document.addEventListener(
    'click',
    (e) => {
      if (!e.altKey) return;

      const el = e.target;
      const selector = makeSelector(el);
      const text = (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 80);

      console.log('[autoTT PICK]', {
        selector,
        tag: el.tagName?.toLowerCase() || null,
        id: el.id || null,
        classes: el.className || null,
        textPreview: text || null,
      }, el);

      e.preventDefault();
      e.stopPropagation();
    },
    true
  );
})();
