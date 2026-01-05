// ==UserScript==
// @name         Terraforming Titans - Data Inspector HUD (Overlay + Paths + Live Values)
// @namespace    https://github.com/kov27/Terraforming-Titans-Scripts
// @version      0.6.0
// @description  Overlay HUD that shows live resources + structures with copyable JS paths and inspectable details. Built to help you write TT scripts.
// @match        https://html-classic.itch.zone/html/*/index.html
// @grant        unsafeWindow
// @grant        GM_setClipboard
// ==/UserScript==

(function () {
  'use strict';

  var W = (typeof unsafeWindow !== 'undefined') ? unsafeWindow : window;

  // --------------------------
  // Simple helper functions
  // --------------------------

  // "Is this a normal object?" (not null, not array)
  function isObj(x) { return x && typeof x === 'object' && !Array.isArray(x); }

  // Convert anything into a number safely (bad values -> 0)
  function num(x) {
    var n = Number(x);
    return isFinite(n) ? n : 0;
  }

  // Format big numbers so they're readable, but still accurate enough for debugging
  function fmt(n) {
    if (!isFinite(n)) return String(n);
    var abs = Math.abs(n);

    // show integers with commas when they're not huge
    if (abs < 1e6) {
      var s = (Math.round(n) === n) ? String(n) : n.toFixed(3);
      // add commas to integer part
      var parts = s.split('.');
      parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
      return parts.join('.');
    }

    // otherwise scientific-ish (still readable)
    return n.toExponential(6);
  }

  // Copy text to clipboard (Violentmonkey supports GM_setClipboard)
  function copyText(text) {
    try {
      if (typeof GM_setClipboard === 'function') {
        GM_setClipboard(text);
        return true;
      }
    } catch (e) {}

    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text);
        return true;
      }
    } catch (e2) {}

    console.log('[TTDI HUD] Copy failed; logging instead:\n' + text);
    return false;
  }

  // A safe-ish stringify that won’t explode on circular refs, and won’t produce megabytes
  function safeStringify(obj, maxChars) {
    maxChars = maxChars || 30000;
    var seen = new WeakSet();
    var out = '';

    try {
      out = JSON.stringify(obj, function (k, v) {
        if (typeof v === 'object' && v !== null) {
          if (seen.has(v)) return '[Circular]';
          seen.add(v);
        }
        // avoid dumping giant arrays
        if (Array.isArray(v) && v.length > 200) return '[Array len=' + v.length + ']';
        return v;
      }, 2);
    } catch (e) {
      out = String(e);
    }

    if (out.length > maxChars) {
      out = out.slice(0, maxChars) + '\n\n[...truncated at ' + maxChars + ' chars...]';
    }
    return out;
  }

  // --------------------------
  // Read game data
  // --------------------------

  function gameReady() {
    // These are the main things you want for scripting
    return !!(W && W.resources && W.structures);
  }

  function collectResources() {
    var result = [];
    var paths = {};

    if (!isObj(W.resources)) return { list: result, paths: paths };

    Object.keys(W.resources).forEach(function (catName) {
      var cat = W.resources[catName];
      if (!isObj(cat)) return;

      Object.keys(cat).forEach(function (resName) {
        var r = cat[resName];
        if (!isObj(r)) return;

        var key = catName + ':' + resName;
        var path = 'window.resources.' + catName + '.' + resName;

        paths[key] = path;

        result.push({
          kind: 'resource',
          key: key,
          display: key,
          path: path,
          value: num(r.value),
          cap: num(r.cap),
          prod: num(r.productionRate),
          cons: num(r.consumptionRate),
          net: num(r.productionRate) - num(r.consumptionRate),
          unlocked: !!r.unlocked,
          rawObj: r
        });
      });
    });

    // stable ordering
    result.sort(function (a, b) { return a.key.localeCompare(b.key); });

    return { list: result, paths: paths };
  }

  function collectStructures() {
    var result = [];
    var paths = {};

    if (!isObj(W.structures)) return { list: result, paths: paths };

    Object.keys(W.structures).forEach(function (k) {
      var s = W.structures[k];
      if (!isObj(s)) return;

      var path = 'window.structures["' + k + '"]';
      paths[k] = path;

      result.push({
        kind: 'structure',
        key: k,
        display: String(s.displayName || s.name || k),
        category: String(s.category || ''),
        path: path,
        count: num(s.count),
        active: num(s.active),
        requiresWorker: num(s.requiresWorker),
        effWorkerNeed: num(s.effWorkerNeed),
        autoBuildEnabled: !!s.autoBuildEnabled,
        autoActiveEnabled: !!s.autoActiveEnabled,
        autoBuildBasis: String(s.autoBuildBasis || ''),
        autoBuildPercent: num(s.autoBuildPercent),
        rawObj: s
      });
    });

    result.sort(function (a, b) { return a.display.localeCompare(b.display); });

    return { list: result, paths: paths };
  }

  function collectKnownGlobals() {
    var names = ['resources', 'structures', 'buildings', 'colonies', 'research', 'game', 'settings'];
    var out = [];
    names.forEach(function (n) {
      if (typeof W[n] === 'undefined') return;
      var v = W[n];
      var type = (v === null) ? 'null' : typeof v;
      var summary = '';
      if (isObj(v)) summary = 'keys=' + Object.keys(v).length;
      else if (Array.isArray(v)) summary = 'len=' + v.length;
      out.push({ name: n, type: type, summary: summary });
    });
    return out;
  }

  function buildSnapshot() {
    var res = collectResources();
    var bld = collectStructures();

    return {
      t: Date.now(),
      deep: false,
      resources: {
        list: res.list,
        paths: res.paths
      },
      buildings: {
        list: bld.list,
        paths: bld.paths,
        sources: { structures: true }
      },
      knownGlobals: collectKnownGlobals()
    };
  }

  // --------------------------
  // HUD / Overlay UI
  // --------------------------

  var HUD = {
    root: null,
    statusEl: null,
    searchEl: null,
    tab: 'resources',
    autoRefresh: true,
    intervalMs: 1000,
    selected: null,
    lastData: null
  };

  function addStyles() {
    if (document.getElementById('ttdiHudStyles')) return;

    var css = `
#ttdiHud {
  position: fixed;
  right: 12px;
  bottom: 12px;
  width: 520px;
  height: 420px;
  z-index: 2147483647;
  background: rgba(18,18,18,0.92);
  color: #fff;
  border: 1px solid rgba(255,255,255,0.14);
  border-radius: 12px;
  box-shadow: 0 10px 35px rgba(0,0,0,0.45);
  font: 12px/1.35 system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
  overflow: hidden;
}
#ttdiHud * { box-sizing: border-box; }

#ttdiHudHeader {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 10px;
  background: rgba(255,255,255,0.06);
  border-bottom: 1px solid rgba(255,255,255,0.10);
  cursor: move;
  user-select: none;
}
#ttdiTitle { font-weight: 800; letter-spacing: 0.2px; }
#ttdiStatus { margin-left: auto; opacity: 0.75; font-size: 11px; }

#ttdiTopBar {
  display: flex;
  gap: 8px;
  padding: 8px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.10);
}
#ttdiSearch {
  flex: 1;
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(0,0,0,0.25);
  color: #fff;
  outline: none;
}
#ttdiButtons { display:flex; gap:6px; }
.ttdiBtn {
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.06);
  color: #fff;
  cursor: pointer;
}
.ttdiBtn:hover { background: rgba(255,255,255,0.10); }

#ttdiTabs {
  display: flex;
  gap: 6px;
  padding: 0 10px 8px 10px;
  border-bottom: 1px solid rgba(255,255,255,0.10);
}
.ttdiTab {
  padding: 6px 8px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.14);
  background: rgba(255,255,255,0.04);
  cursor: pointer;
}
.ttdiTabActive { background: rgba(255,255,255,0.12); }

#ttdiBody {
  display: grid;
  grid-template-columns: 1.2fr 0.8fr;
  height: calc(100% - 118px);
}
#ttdiList {
  overflow: auto;
  border-right: 1px solid rgba(255,255,255,0.10);
}
#ttdiDetail {
  overflow: auto;
  padding: 10px;
}
#ttdiTable {
  width: 100%;
  border-collapse: collapse;
}
#ttdiTable th, #ttdiTable td {
  padding: 6px 8px;
  border-bottom: 1px solid rgba(255,255,255,0.08);
  vertical-align: top;
}
#ttdiTable th {
  position: sticky;
  top: 0;
  background: rgba(18,18,18,0.96);
  z-index: 2;
  font-weight: 700;
}
.ttdiRow { cursor: pointer; }
.ttdiRow:hover { background: rgba(255,255,255,0.05); }
.ttdiRowSelected { background: rgba(255,255,255,0.10); }

.ttdiMono { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, "Liberation Mono", monospace; font-size: 11px; }
.ttdiSmall { font-size: 11px; opacity: 0.85; }
.ttdiBad { color: #ffb0b0; }
.ttdiGood { color: #b6ffb6; }
pre#ttdiPre {
  white-space: pre-wrap;
  word-break: break-word;
  padding: 8px;
  border-radius: 10px;
  border: 1px solid rgba(255,255,255,0.12);
  background: rgba(0,0,0,0.25);
  margin: 8px 0 0 0;
}
    `.trim();

    var style = document.createElement('style');
    style.id = 'ttdiHudStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function makeHud() {
    if (HUD.root) return;

    addStyles();

    var root = document.createElement('div');
    root.id = 'ttdiHud';
    root.innerHTML = `
      <div id="ttdiHudHeader">
        <div id="ttdiTitle">TT Data Inspector HUD</div>
        <div id="ttdiStatus">Starting…</div>
      </div>

      <div id="ttdiTopBar">
        <input id="ttdiSearch" placeholder="Search (e.g. colony:energy, electronicsFactory, waterPump, autoBuild…)" />
        <div id="ttdiButtons">
          <button class="ttdiBtn" id="ttdiRefresh">Refresh</button>
          <button class="ttdiBtn" id="ttdiAuto">Auto: ON</button>
          <button class="ttdiBtn" id="ttdiCopy">Copy JSON</button>
        </div>
      </div>

      <div id="ttdiTabs">
        <div class="ttdiTab ttdiTabActive" data-tab="resources">Resources</div>
        <div class="ttdiTab" data-tab="structures">Structures</div>
        <div class="ttdiTab" data-tab="globals">Globals</div>
      </div>

      <div id="ttdiBody">
        <div id="ttdiList"></div>
        <div id="ttdiDetail">
          <div class="ttdiSmall">Click a row to inspect it. Use Copy buttons to paste paths into your code.</div>
          <div id="ttdiDetailInner"></div>
        </div>
      </div>
    `;

    document.body.appendChild(root);

    HUD.root = root;
    HUD.statusEl = root.querySelector('#ttdiStatus');
    HUD.searchEl = root.querySelector('#ttdiSearch');

    // Buttons
    root.querySelector('#ttdiRefresh').addEventListener('click', function () {
      refreshNow(true);
    });

    root.querySelector('#ttdiAuto').addEventListener('click', function (e) {
      HUD.autoRefresh = !HUD.autoRefresh;
      e.target.textContent = 'Auto: ' + (HUD.autoRefresh ? 'ON' : 'OFF');
      refreshNow(true);
    });

    root.querySelector('#ttdiCopy').addEventListener('click', function () {
      var snap = buildSnapshot();
      var ok = copyText(JSON.stringify(snap, null, 2));
      setStatus(ok ? 'Copied snapshot JSON.' : 'Copy failed (logged to console).');
    });

    // Tabs
    Array.prototype.slice.call(root.querySelectorAll('.ttdiTab')).forEach(function (el) {
      el.addEventListener('click', function () {
        HUD.tab = el.getAttribute('data-tab');
        Array.prototype.slice.call(root.querySelectorAll('.ttdiTab')).forEach(function (t) {
          t.classList.toggle('ttdiTabActive', t === el);
        });
        render();
      });
    });

    // Search rerender
    HUD.searchEl.addEventListener('input', function () {
      render();
    });

    // Make draggable
    makeDraggable(root, root.querySelector('#ttdiHudHeader'));

    setStatus('HUD ready.');
  }

  function setStatus(msg) {
    if (!HUD.statusEl) return;
    HUD.statusEl.textContent = msg;
  }

  function makeDraggable(panel, handle) {
    var dragging = false;
    var startX = 0, startY = 0;
    var startLeft = 0, startTop = 0;

    // Switch from bottom/right anchoring to top/left when dragging starts
    function ensureTopLeft() {
      var rect = panel.getBoundingClientRect();
      panel.style.left = rect.left + 'px';
      panel.style.top = rect.top + 'px';
      panel.style.right = 'auto';
      panel.style.bottom = 'auto';
    }

    handle.addEventListener('mousedown', function (e) {
      dragging = true;
      ensureTopLeft();
      var rect = panel.getBoundingClientRect();
      startX = e.clientX;
      startY = e.clientY;
      startLeft = rect.left;
      startTop = rect.top;
      e.preventDefault();
    });

    window.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      var dx = e.clientX - startX;
      var dy = e.clientY - startY;
      panel.style.left = (startLeft + dx) + 'px';
      panel.style.top = (startTop + dy) + 'px';
    });

    window.addEventListener('mouseup', function () {
      dragging = false;
    });
  }

  // --------------------------
  // Rendering
  // --------------------------

  function matchesSearch(text, q) {
    if (!q) return true;
    return String(text).toLowerCase().indexOf(q) !== -1;
  }

  function render() {
    if (!HUD.root) return;

    var listHost = HUD.root.querySelector('#ttdiList');
    var detailHost = HUD.root.querySelector('#ttdiDetailInner');
    var q = (HUD.searchEl && HUD.searchEl.value || '').trim().toLowerCase();

    if (!HUD.lastData) {
      listHost.innerHTML = '<div style="padding:10px;opacity:0.8;">No data yet…</div>';
      detailHost.innerHTML = '';
      return;
    }

    // Build lists per tab
    var rows = [];
    if (HUD.tab === 'resources') rows = HUD.lastData.resources.list;
    else if (HUD.tab === 'structures') rows = HUD.lastData.structures.list;
    else if (HUD.tab === 'globals') rows = HUD.lastData.globals.list;

    // Apply search
    if (q) {
      rows = rows.filter(function (r) {
        return matchesSearch(JSON.stringify(r), q);
      });
    }

    // Render table
    if (HUD.tab === 'resources') {
      listHost.innerHTML = renderResourcesTable(rows);
    } else if (HUD.tab === 'structures') {
      listHost.innerHTML = renderStructuresTable(rows);
    } else {
      listHost.innerHTML = renderGlobalsTable(rows);
    }

    // Wire row click handlers
    Array.prototype.slice.call(listHost.querySelectorAll('[data-row-index]')).forEach(function (tr) {
      tr.addEventListener('click', function () {
        var idx = Number(tr.getAttribute('data-row-index'));
        HUD.selected = rows[idx] || null;
        renderDetail(detailHost);
        // highlight selected
        Array.prototype.slice.call(listHost.querySelectorAll('.ttdiRow')).forEach(function (rEl) {
          rEl.classList.toggle('ttdiRowSelected', rEl === tr);
        });
      });
    });

    // Re-render details (keeps it updated on refresh)
    renderDetail(detailHost);
  }

  function renderResourcesTable(rows) {
    var html = '';
    html += '<table id="ttdiTable">';
    html += '<thead><tr>' +
      '<th>Key</th>' +
      '<th>Value</th>' +
      '<th>Net</th>' +
      '<th class="ttdiSmall">Path</th>' +
    '</tr></thead><tbody>';

    rows.forEach(function (r, i) {
      var bad = (r.key === 'colony:workers' && r.value < 0);
      var netClass = (r.net >= 0) ? 'ttdiGood' : 'ttdiBad';
      html += '<tr class="ttdiRow" data-row-index="' + i + '">' +
        '<td class="' + (bad ? 'ttdiBad' : '') + '">' + escapeHtml(r.key) + '</td>' +
        '<td class="ttdiMono">' + escapeHtml(fmt(r.value)) + '</td>' +
        '<td class="ttdiMono ' + netClass + '">' + escapeHtml(fmt(r.net)) + '</td>' +
        '<td class="ttdiMono ttdiSmall">' + escapeHtml(r.path) + '</td>' +
      '</tr>';
    });

    html += '</tbody></table>';
    return html;
  }

  function renderStructuresTable(rows) {
    var html = '';
    html += '<table id="ttdiTable">';
    html += '<thead><tr>' +
      '<th>Name</th>' +
      '<th>Count / Active</th>' +
      '<th>Auto</th>' +
      '<th class="ttdiSmall">Path</th>' +
    '</tr></thead><tbody>';

    rows.forEach(function (s, i) {
      var auto = (s.autoBuildEnabled ? 'Build ' : '') + (s.autoActiveEnabled ? 'Active' : '');
      if (!auto) auto = '—';

      html += '<tr class="ttdiRow" data-row-index="' + i + '">' +
        '<td>' +
          '<div>' + escapeHtml(s.display) + '</div>' +
          '<div class="ttdiSmall ttdiMono">' + escapeHtml(s.key) + '</div>' +
        '</td>' +
        '<td class="ttdiMono">' + escapeHtml(fmt(s.count)) + ' / ' + escapeHtml(fmt(s.active)) + '</td>' +
        '<td class="ttdiMono">' + escapeHtml(auto) + '</td>' +
        '<td class="ttdiMono ttdiSmall">' + escapeHtml(s.path) + '</td>' +
      '</tr>';
    });

    html += '</tbody></table>';
    return html;
  }

  function renderGlobalsTable(rows) {
    var html = '';
    html += '<table id="ttdiTable">';
    html += '<thead><tr>' +
      '<th>Name</th>' +
      '<th>Type</th>' +
      '<th>Summary</th>' +
    '</tr></thead><tbody>';

    rows.forEach(function (g, i) {
      html += '<tr class="ttdiRow" data-row-index="' + i + '">' +
        '<td class="ttdiMono">' + escapeHtml(g.name) + '</td>' +
        '<td class="ttdiMono">' + escapeHtml(g.type) + '</td>' +
        '<td class="ttdiMono">' + escapeHtml(g.summary || '') + '</td>' +
      '</tr>';
    });

    html += '</tbody></table>';
    return html;
  }

  function renderDetail(host) {
    if (!host) return;

    var sel = HUD.selected;
    if (!sel) {
      host.innerHTML = '<div class="ttdiSmall">No selection.</div>';
      return;
    }

    var title = '';
    var path = '';
    var body = '';

    if (sel.kind === 'resource') {
      title = sel.key;
      path = sel.path;

      body += '<div><b>Current</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.value)) + '</span></div>';
      body += '<div><b>Cap</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.cap)) + '</span></div>';
      body += '<div><b>Prod</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.prod)) + '</span></div>';
      body += '<div><b>Cons</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.cons)) + '</span></div>';
      body += '<div><b>Net</b>: <span class="ttdiMono ' + (sel.net >= 0 ? 'ttdiGood' : 'ttdiBad') + '">' + escapeHtml(fmt(sel.net)) + '</span></div>';
      body += '<div><b>Unlocked</b>: <span class="ttdiMono">' + escapeHtml(String(sel.unlocked)) + '</span></div>';
      body += '<div class="ttdiSmall" style="margin-top:6px;">Helpful code:</div>';
      body += '<div class="ttdiMono ttdiSmall">Read value → <span class="ttdiMono">(' + escapeHtml(path) + '.value)</span></div>';
      body += '<div class="ttdiMono ttdiSmall">Read net → <span class="ttdiMono">(' + escapeHtml(path) + '.productionRate - ' + escapeHtml(path) + '.consumptionRate)</span></div>';

    } else if (sel.kind === 'structure') {
      title = sel.display + ' (' + sel.key + ')';
      path = sel.path;

      body += '<div><b>Count</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.count)) + '</span></div>';
      body += '<div><b>Active</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.active)) + '</span></div>';
      body += '<div><b>requiresWorker</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.requiresWorker)) + '</span></div>';
      body += '<div><b>effWorkerNeed</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.effWorkerNeed)) + '</span></div>';
      body += '<div><b>autoBuildEnabled</b>: <span class="ttdiMono">' + escapeHtml(String(sel.autoBuildEnabled)) + '</span></div>';
      body += '<div><b>autoActiveEnabled</b>: <span class="ttdiMono">' + escapeHtml(String(sel.autoActiveEnabled)) + '</span></div>';
      body += '<div><b>autoBuildBasis</b>: <span class="ttdiMono">' + escapeHtml(sel.autoBuildBasis) + '</span></div>';
      body += '<div><b>autoBuildPercent</b>: <span class="ttdiMono">' + escapeHtml(fmt(sel.autoBuildPercent)) + '</span></div>';
      body += '<div class="ttdiSmall" style="margin-top:6px;">Helpful code:</div>';
      body += '<div class="ttdiMono ttdiSmall">Read count → <span class="ttdiMono">(' + escapeHtml(path) + '.count)</span></div>';
      body += '<div class="ttdiMono ttdiSmall">Set autobuild → <span class="ttdiMono">(' + escapeHtml(path) + '.autoBuildPercent = 1)</span></div>';
    } else {
      title = sel.name || 'Global';
      path = 'window.' + (sel.name || '');
    }

    host.innerHTML =
      '<div style="font-weight:800;margin-bottom:6px;">' + escapeHtml(title) + '</div>' +
      '<div class="ttdiSmall">Path:</div>' +
      '<div class="ttdiMono" style="margin-bottom:8px;">' + escapeHtml(path) + '</div>' +
      '<div style="display:flex;gap:6px;flex-wrap:wrap;">' +
        '<button class="ttdiBtn" id="ttdiCopyPath">Copy Path</button>' +
        '<button class="ttdiBtn" id="ttdiCopyValue">Copy “Read Value”</button>' +
        '<button class="ttdiBtn" id="ttdiCopyObj">Copy Object JSON</button>' +
      '</div>' +
      '<div style="margin-top:10px;">' + body + '</div>' +
      '<div class="ttdiSmall" style="margin-top:10px;">Raw object (for variable names / keys):</div>' +
      '<pre id="ttdiPre">' + escapeHtml(safeStringify(sel.rawObj || sel, 25000)) + '</pre>';

    // Wire detail buttons
    var btnPath = HUD.root.querySelector('#ttdiCopyPath');
    var btnValue = HUD.root.querySelector('#ttdiCopyValue');
    var btnObj = HUD.root.querySelector('#ttdiCopyObj');

    if (btnPath) btnPath.onclick = function () {
      copyText(path);
      setStatus('Copied path.');
    };

    if (btnValue) btnValue.onclick = function () {
      var snippet = '';
      if (sel.kind === 'resource') snippet = path + '.value';
      else if (sel.kind === 'structure') snippet = path + '.count';
      else snippet = path;
      copyText(snippet);
      setStatus('Copied read snippet.');
    };

    if (btnObj) btnObj.onclick = function () {
      var txt = safeStringify(sel.rawObj || sel, 50000);
      copyText(txt);
      setStatus('Copied object JSON.');
    };
  }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // --------------------------
  // Data refresh loop
  // --------------------------

  function refreshNow(forceRender) {
    if (!HUD.root) return;

    if (!gameReady()) {
      setStatus('Waiting for game objects (resources/structures)…');
      HUD.lastData = null;
      if (forceRender) render();
      return;
    }

    // Gather the data we show in the HUD
    var res = collectResources();
    var st = collectStructures();
    var gl = collectKnownGlobals();

    HUD.lastData = {
      resources: res,
      structures: st,
      globals: gl
    };

    setStatus('Live. Resources: ' + res.list.length + ' | Structures: ' + st.list.length);
    if (forceRender) render();
  }

  function loop() {
    if (!HUD.root) return;

    if (HUD.autoRefresh) refreshNow(true);
    setTimeout(loop, HUD.intervalMs);
  }

  // --------------------------
  // Boot
  // --------------------------

  function initWhenBodyReady() {
    if (!document.body) {
      setTimeout(initWhenBodyReady, 200);
      return;
    }
    makeHud();
    refreshNow(true);
    loop();
  }

  initWhenBodyReady();

})();
