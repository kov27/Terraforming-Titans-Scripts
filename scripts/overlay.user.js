// ==UserScript==
// @name         TT Data Inspector (Simple)
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.3.0
// @description  Simple snapshot tool: reads window.resources + window.structures and copies a JSON dump to clipboard.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        unsafeWindow
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  // Use the real page window (userscript-safe)
  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // ---- Small helpers ----

  // Safely turn something into a number (or 0 if it isn't a number)
  function num(x) {
    var n = Number(x);
    return isFinite(n) ? n : 0;
  }

  // True if this looks like a normal object (not null, not an array)
  function isObj(x) {
    return x && typeof x === 'object' && !Array.isArray(x);
  }

  // Try to copy text to clipboard (works in more environments)
  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text);
        return true;
      }
    } catch (e) {}

    // Fallback for modern browsers (may require user gesture)
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e2) {}

    // Last fallback: log it
    console.log('[TT Inspector] Clipboard copy failed; output logged instead:\n', text);
    return false;
  }

  // Check the game objects we expect exist yet
  function gameReady() {
    return !!(W && W.resources && W.structures);
  }

  // ---- Resources snapshot ----

  // Read all resources into: { categories: {...}, paths: {...} }
  function collectResources() {
    var out = { categories: {}, paths: {} };

    if (!W.resources || !isObj(W.resources)) return out;

    // Loop categories like "colony", "surface", etc.
    Object.keys(W.resources).forEach(function (catName) {
      var cat = W.resources[catName];
      if (!isObj(cat)) return;

      out.categories[catName] = {};

      // Loop items inside the category like "energy", "metal", etc.
      Object.keys(cat).forEach(function (resName) {
        var r = cat[resName];
        if (!isObj(r)) return;

        // Build "colony:energy" style key
        var k = catName + ':' + resName;

        out.categories[catName][resName] = {
          value: num(r.value),
          cap: num(r.cap),
          productionRate: num(r.productionRate),
          consumptionRate: num(r.consumptionRate),
          overflowRate: num(r.overflowRate),
          unlocked: !!r.unlocked
        };

        out.paths[k] = 'window.resources.' + catName + '.' + resName;
      });
    });

    return out;
  }

  // Build an index so we can map "energy" -> "colony:energy" if it's unique
  function buildResourceIndex(resourcesSnapshot) {
    var byName = {}; // energy -> ["colony:energy"]
    Object.keys(resourcesSnapshot.paths).forEach(function (fullKey) {
      var parts = fullKey.split(':');
      var name = parts[1] || fullKey;
      if (!byName[name]) byName[name] = [];
      byName[name].push(fullKey);
    });
    return { byName: byName };
  }

  // ---- Buildings snapshot ----

  // Extract "produces/consumes" by reading keys from production/consumption objects.
  // This is best-effort: if the key matches exactly one resource name, we map it.
  function extractIO(ioObj, resIndex) {
    var out = [];
    if (!isObj(ioObj)) return out;

    Object.keys(ioObj).forEach(function (k) {
      // If it already looks like "colony:energy", keep it
      if (k.indexOf(':') !== -1) {
        out.push(k);
        return;
      }

      // Otherwise try to map "energy" -> ["colony:energy"] if unique
      var matches = resIndex.byName[k] || [];
      if (matches.length === 1) out.push(matches[0]);
      else if (matches.length > 1) out.push('ambiguous:' + k); // not sure which one
      else out.push('unknown:' + k); // not found in resources list
    });

    return out;
  }

  // Read all structures into: { list: [...], sources: {...}, pathHint: "window.structures" }
  function collectBuildings(resourcesSnapshot) {
    var out = {
      list: [],
      sources: { structures: false, buildings: false, colonies: false },
      pathHint: ''
    };

    var structures = W.structures;
    if (!isObj(structures)) return out;

    out.sources.structures = true;
    out.pathHint = 'window.structures';

    var resIndex = buildResourceIndex(resourcesSnapshot);

    Object.keys(structures).forEach(function (key) {
      var s = structures[key];
      if (!isObj(s)) return;

      // Pull a few common fields you showed in your dump
      var item = {
        key: key,
        displayName: String(s.displayName || s.name || key),
        category: String(s.category || ''),
        unlocked: !!s.unlocked,
        isHidden: !!s.isHidden,
        count: num(s.count),
        active: num(s.active),

        requiresWorker: num(s.requiresWorker),
        effWorkerNeed: num(s.effWorkerNeed),

        autoBuildEnabled: !!s.autoBuildEnabled,
        autoActiveEnabled: !!s.autoActiveEnabled,
        autoBuildBasis: String(s.autoBuildBasis || ''),
        autoBuildPercent: num(s.autoBuildPercent),

        produces: extractIO(s.production, resIndex),
        consumes: extractIO(s.consumption, resIndex),

        pathGuess: 'window.structures["' + key + '"]',

        // keys = list of property names (helps you explore the object)
        keys: Object.keys(s)
      };

      out.list.push(item);
    });

    // Keep it stable so the list doesn't shuffle each run
    out.list.sort(function (a, b) {
      return a.displayName.localeCompare(b.displayName);
    });

    return out;
  }

  // ---- Globals snapshot ----

  // Just list some common globals you care about (like in your dump)
  function collectKnownGlobals() {
    var names = ['resources', 'buildings', 'colonies', 'research', 'game', 'settings'];
    return names
      .filter(function (n) { return typeof W[n] !== 'undefined'; })
      .map(function (n) {
        var v = W[n];
        var type = (v === null) ? 'null' : typeof v;
        var summary = '';

        if (isObj(v)) summary = 'keys=' + Object.keys(v).length;
        else if (Array.isArray(v)) summary = 'len=' + v.length;

        return { name: n, type: type, summary: summary };
      });
  }

  // ---- Build the final report (matches your layout) ----
  function buildReport(deep) {
    var resources = collectResources();
    var buildings = collectBuildings(resources);

    return {
      t: Date.now(),
      deep: !!deep,
      resources: resources,
      buildings: buildings,
      knownGlobals: collectKnownGlobals()
    };
  }

  // ---- Simple UI ----
  var hud;

  function makeHud() {
    if (hud) return;

    hud = document.createElement('div');
    hud.style.position = 'fixed';
    hud.style.right = '12px';
    hud.style.bottom = '12px';
    hud.style.zIndex = 999999;
    hud.style.background = 'rgba(20,20,20,0.92)';
    hud.style.border = '1px solid rgba(255,255,255,0.15)';
    hud.style.borderRadius = '10px';
    hud.style.padding = '10px';
    hud.style.color = '#fff';
    hud.style.font = '12px/1.3 system-ui, Segoe UI, Roboto, Arial';
    hud.style.width = '220px';

    hud.innerHTML =
      '<div style="font-weight:700;margin-bottom:6px;">TT Data Inspector</div>' +
      '<label style="display:flex;gap:6px;align-items:center;margin-bottom:8px;">' +
        '<input id="ttdi_deep" type="checkbox" />' +
        '<span>Deep mode</span>' +
      '</label>' +
      '<button id="ttdi_copy" style="width:100%;padding:6px 8px;border-radius:8px;border:1px solid rgba(255,255,255,0.2);background:rgba(255,255,255,0.08);color:#fff;cursor:pointer;">Copy JSON</button>' +
      '<div id="ttdi_status" style="opacity:0.75;margin-top:8px;">Waiting for game...</div>';

    document.body.appendChild(hud);

    hud.querySelector('#ttdi_copy').addEventListener('click', function () {
      if (!gameReady()) {
        setStatus('Game not ready yet.');
        return;
      }

      var deep = hud.querySelector('#ttdi_deep').checked;
      var report = buildReport(deep);
      var text = JSON.stringify(report, null, 2);

      var ok = copyText(text);
      setStatus(ok ? 'Copied to clipboard.' : 'Copy failed; logged to console.');
    });
  }

  function setStatus(msg) {
    if (!hud) return;
    var el = hud.querySelector('#ttdi_status');
    if (el) el.textContent = msg;
  }

  // ---- Main loop ----
  function tick() {
    makeHud();
    setStatus(gameReady() ? 'Ready.' : 'Waiting for game...');
    setTimeout(tick, 1000);
  }

  tick();

})();
