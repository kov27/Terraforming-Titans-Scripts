// ==UserScript==
// @name         Auto TT
// @namespace    auto-tt
// @version      0.0.1
// @description  automation for Terraforming Titans.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        none
// ==/UserScript==

(() => {
  'use strict';

  // 1) Console proof (open DevTools -> Console)
  console.log('[autoTT] userscript loaded ✅', { url: location.href, time: new Date().toISOString() });

  // 2) On-page proof (a small banner)
  const badge = document.createElement('div');
  badge.textContent = 'autoTT loaded ✅';
  badge.style.position = 'fixed';
  badge.style.top = '10px';
  badge.style.right = '10px';
  badge.style.zIndex = '999999';
  badge.style.padding = '6px 10px';
  badge.style.font = '12px/1.2 sans-serif';
  badge.style.background = 'rgba(0,0,0,0.75)';
  badge.style.color = 'white';
  badge.style.borderRadius = '8px';
  document.documentElement.appendChild(badge);

  setTimeout(() => badge.remove(), 2500);
})();
