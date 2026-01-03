// ==UserScript==
// @name         TT - Galactic Market Automator (Working)
// @namespace    tt-market-fixed
// @version      3.0.0
// @description  Actually working market automation - finds inputs, writes values, clicks buttons
// @match        https://html-classic.itch.zone/html/*/index.html
// @match        https://html.itch.zone/html/*/index.html
// @match        https://*.ssl.hwcdn.net/html/*/index.html
// @match        https://*.hwcdn.net/html/*/index.html
// @run-at       document-idle
// @grant        GM_getValue
// @grant        GM_setValue
// ==/UserScript==

(() => {
  'use strict';

  // ============ CONFIG ============
  const CFG = {
    enabled: false, // Start disabled, user enables after setup
    
    // Trading strategy
    buyFloorPercent: 20,  // Buy when below 20% of cap
    sellCeilPercent: 90,  // Sell when above 90% of cap
    
    // Funding management
    minFunding: 5000,     // Never go below this
    
    // Tick rate
    tickMs: 1000,
    
    // UI
    showHud: true,
  };

  const log = (...args) => console.log("[Market]", ...args);

  // ============ STORAGE ============
  const STORE_KEY = 'tt_market_v3';
  
  function loadSettings() {
    try {
      const saved = localStorage.getItem(STORE_KEY);
      if (saved) {
        const parsed = JSON.parse(saved);
        Object.assign(CFG, parsed);
      }
    } catch {}
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(CFG));
    } catch {}
  }

  loadSettings();

  // ============ GAME ACCESS ============
  function getResources() {
    try {
      return (typeof resources !== "undefined") ? resources : window.resources || null;
    } catch { return null; }
  }

  function getMarket() {
    try {
      return (typeof galacticMarket !== "undefined") ? galacticMarket : window.galacticMarket || null;
    } catch { return null; }
  }

  // ============ DOM HELPERS ============
  function setInputValue(input, value) {
    if (!input) return false;
    
    const strValue = String(Math.floor(value));
    input.value = strValue;
    
    // Trigger events to make sure game notices
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    
    return true;
  }

  function findMarketInputs() {
    // Strategy 1: Look for the galacticMarket object's UI elements
    const market = getMarket();
    
    const buyInputs = new Map();
    const sellInputs = new Map();
    
    // Strategy 2: Find all number inputs on page
    const inputs = Array.from(document.querySelectorAll('input[type="number"], input[type="text"]'));
    
    log(`Found ${inputs.length} total inputs on page`);
    
    inputs.forEach(input => {
      // Skip if input is not visible
      const rect = input.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return;
      
      // Find parent container
      let parent = input.closest('tr, div[class*="row"], li, .market-row');
      if (!parent) {
        parent = input.parentElement?.parentElement || input.parentElement;
      }
      if (!parent) return;
      
      // Get all text content from parent
      const text = parent.textContent.toLowerCase();
      
      // Also check input attributes
      const placeholder = (input.placeholder || "").toLowerCase();
      const id = (input.id || "").toLowerCase();
      const className = (input.className || "").toLowerCase();
      const combined = text + " " + placeholder + " " + id + " " + className;
      
      // Common resource names
      const resources = [
        'metal', 'silicon', 'glass', 'electronics', 'components', 
        'water', 'food', 'superalloys', 'energy', 'superconductors'
      ];
      
      let foundResource = null;
      for (const res of resources) {
        if (combined.includes(res)) {
          foundResource = res;
          break;
        }
      }
      
      if (!foundResource) return;
      
      // Determine if buy or sell based on multiple hints
      const isBuy = combined.includes('buy') || 
                    combined.includes('purchase') ||
                    parent.querySelector('[class*="buy"]') !== null;
                    
      const isSell = combined.includes('sell') || 
                     parent.querySelector('[class*="sell"]') !== null;
      
      if (isBuy) {
        log(`Found BUY input for ${foundResource}:`, input);
        buyInputs.set(foundResource, input);
      } else if (isSell) {
        log(`Found SELL input for ${foundResource}:`, input);
        sellInputs.set(foundResource, input);
      } else {
        // Ambiguous - might be a combined input or first of pair
        // Check siblings
        const nextInput = parent.querySelector('input[type="number"]:nth-of-type(2)');
        if (nextInput && nextInput !== input) {
          // Assume first is buy, second is sell (common pattern)
          log(`Found input pair for ${foundResource}`);
          buyInputs.set(foundResource, input);
          sellInputs.set(foundResource, nextInput);
        } else if (!buyInputs.has(foundResource)) {
          log(`Found ambiguous input for ${foundResource} (assuming buy)`);
          buyInputs.set(foundResource, input);
        }
      }
    });
    
    log(`Detected: ${buyInputs.size} buy inputs, ${sellInputs.size} sell inputs`);
    
    return { buyInputs, sellInputs };
  }

  function findRunButton() {
    // Look for "Run" or "Execute" button
    const buttons = Array.from(document.querySelectorAll('button'));
    
    log(`Scanning ${buttons.length} buttons for market run button`);
    
    for (const btn of buttons) {
      const rect = btn.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) continue;
      
      const text = btn.textContent.toLowerCase().trim();
      const title = (btn.title || "").toLowerCase();
      const combined = text + " " + title;
      
      if (combined.includes('run') || 
          combined.includes('execute') || 
          combined.includes('trade') ||
          text === 'go' ||
          combined.includes('market run')) {
        log("Found market run button:", btn);
        return btn;
      }
    }
    
    log("No run button found");
    return null;
  }

  // ============ DIAGNOSTICS ============
  function generateDiagnosticLog() {
    const market = getMarket();
    const res = getResources();
    const { buyInputs, sellInputs } = findMarketInputs();
    const runBtn = findRunButton();

    const log = {
      timestamp: new Date().toISOString(),
      scriptVersion: "3.0.1",
      config: CFG,
      stats: state.trades,
      lastAction: state.lastAction,
      
      detection: {
        marketObjectExists: !!market,
        marketObjectType: market ? typeof market : "null",
        marketObjectKeys: market ? Object.keys(market).slice(0, 20) : [],
        buyInputsFound: buyInputs.size,
        sellInputsFound: sellInputs.size,
        runButtonFound: !!runBtn,
        runButtonText: runBtn ? runBtn.textContent : null,
        totalInputsOnPage: document.querySelectorAll('input').length,
        totalButtonsOnPage: document.querySelectorAll('button').length,
      },
      
      detectedInputs: {
        buy: Array.from(buyInputs.keys()),
        sell: Array.from(sellInputs.keys()),
      },
      
      resourceStates: {},
    };

    // Add resource states
    const resources = ['metal', 'silicon', 'glass', 'electronics', 'components', 
                      'water', 'food', 'superalloys', 'energy', 'funding'];
    
    resources.forEach(name => {
      const state = getResourceState('colony', name);
      if (state) {
        log.resourceStates[name] = {
          value: state.value,
          cap: state.cap,
          prod: state.prod,
          cons: state.cons,
          net: state.prod - state.cons,
          fillPercent: state.cap > 0 ? (state.value / state.cap * 100) : 0,
        };
      }
    });

    return JSON.stringify(log, null, 2);
  }

  // ============ MARKET LOGIC ============
  const state = {
    lastTick: 0,
    lastAction: "",
    trades: { buys: 0, sells: 0 },
  };

  function getResourceState(category, name) {
    const res = getResources();
    const r = res?.[category]?.[name];
    if (!r) return null;
    
    return {
      value: r.value ?? 0,
      cap: r.cap ?? 0,
      prod: r.productionRate ?? 0,
      cons: r.consumptionRate ?? 0,
    };
  }

  function computeTrades() {
    const trades = { buy: new Map(), sell: new Map() };
    
    const resources = ['metal', 'silicon', 'glass', 'electronics', 'components', 
                      'water', 'food', 'superalloys', 'energy'];
    
    resources.forEach(name => {
      const state = getResourceState('colony', name);
      if (!state || state.cap <= 0) return;
      
      const fillPercent = (state.value / state.cap) * 100;
      
      if (fillPercent < CFG.buyFloorPercent) {
        // Need to buy
        const needed = (state.cap * CFG.buyFloorPercent / 100) - state.value;
        trades.buy.set(name, Math.max(0, Math.floor(needed)));
      } else if (fillPercent > CFG.sellCeilPercent) {
        // Can sell
        const excess = state.value - (state.cap * CFG.sellCeilPercent / 100);
        trades.sell.set(name, Math.max(0, Math.floor(excess)));
      }
    });
    
    return trades;
  }

  function executeTrades() {
    if (!CFG.enabled) return;
    
    const market = getMarket();
    log("Market object:", market ? "EXISTS" : "NULL");
    
    const { buyInputs, sellInputs } = findMarketInputs();
    
    if (buyInputs.size === 0 && sellInputs.size === 0) {
      state.lastAction = "No market inputs found - is Galactic Market tab open and visible?";
      log("No inputs found. Total inputs on page:", document.querySelectorAll('input').length);
      return;
    }
    
    const trades = computeTrades();
    
    let wroteCount = 0;
    
    // Write buy amounts
    trades.buy.forEach((amount, resource) => {
      const input = buyInputs.get(resource);
      if (input && amount > 0) {
        log(`Writing BUY ${amount} ${resource}`);
        if (setInputValue(input, amount)) {
          state.trades.buys++;
          wroteCount++;
        }
      }
    });
    
    // Write sell amounts
    trades.sell.forEach((amount, resource) => {
      const input = sellInputs.get(resource);
      if (input && amount > 0) {
        log(`Writing SELL ${amount} ${resource}`);
        if (setInputValue(input, amount)) {
          state.trades.sells++;
          wroteCount++;
        }
      }
    });
    
    log(`Wrote ${wroteCount} trade values`);
    
    // Click run button if found
    const runBtn = findRunButton();
    if (runBtn && !runBtn.disabled) {
      // Check funding first
      const funding = getResourceState('colony', 'funding');
      if (funding && funding.value >= CFG.minFunding) {
        log("Clicking run button");
        setTimeout(() => runBtn.click(), 100);
        state.lastAction = `Executed trades (B:${trades.buy.size} S:${trades.sell.size})`;
      } else {
        state.lastAction = `Skipped - funding too low (${funding?.value ?? 0} < ${CFG.minFunding})`;
      }
    } else {
      state.lastAction = `Set ${wroteCount} trade amounts (no run button ${runBtn ? 'or button disabled' : 'found'})`;
    }
  }

  // ============ MAIN LOOP ============
  function tick() {
    const now = Date.now();
    if (now - state.lastTick < CFG.tickMs) return;
    state.lastTick = now;
    
    try {
      executeTrades();
      updateHUD();
    } catch (err) {
      log("Tick error:", err);
      state.lastAction = `Error: ${err.message}`;
    }
  }

  // ============ HUD ============
  let hudEl = null;

  function createHUD() {
    if (!CFG.showHud || hudEl) return;

    const css = `
      #market-hud {
        position: fixed;
        left: 12px;
        bottom: 12px;
        z-index: 2147483647;
        background: rgba(18, 22, 30, 0.95);
        border: 1px solid rgba(140, 200, 255, 0.3);
        border-radius: 12px;
        padding: 12px;
        color: #e8eefc;
        font: 12px/1.4 system-ui, sans-serif;
        min-width: 320px;
        box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
      }
      #market-hud .title {
        font-weight: 800;
        margin-bottom: 10px;
        font-size: 14px;
      }
      #market-hud .controls {
        display: flex;
        gap: 8px;
        margin-bottom: 10px;
        flex-wrap: wrap;
      }
      #market-hud button {
        background: rgba(255, 255, 255, 0.1);
        border: 1px solid rgba(255, 255, 255, 0.2);
        color: #e8eefc;
        padding: 6px 12px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
        font-weight: 600;
      }
      #market-hud button:hover { background: rgba(255, 255, 255, 0.15); }
      #market-hud button.active {
        background: rgba(100, 200, 100, 0.2);
        border-color: rgba(100, 255, 100, 0.4);
      }
      #market-hud .setting {
        display: flex;
        justify-content: space-between;
        align-items: center;
        margin: 6px 0;
        opacity: 0.9;
      }
      #market-hud .setting input {
        width: 80px;
        background: rgba(0, 0, 0, 0.3);
        border: 1px solid rgba(255, 255, 255, 0.2);
        border-radius: 6px;
        padding: 4px 8px;
        color: #e8eefc;
        font-size: 12px;
      }
      #market-hud .status {
        margin-top: 10px;
        padding: 8px;
        background: rgba(255, 255, 255, 0.05);
        border-radius: 8px;
        font-size: 11px;
        opacity: 0.85;
      }
      #market-hud .stats {
        display: grid;
        grid-template-columns: 1fr 1fr;
        gap: 6px;
        margin-top: 8px;
        font-size: 11px;
        opacity: 0.8;
      }
    `;

    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);

    hudEl = document.createElement("div");
    hudEl.id = "market-hud";

    hudEl.innerHTML = `
      <div class="title">Galactic Market</div>
      
      <div class="controls">
        <button id="market-toggle">${CFG.enabled ? 'STOP' : 'START'}</button>
        <button id="market-scan">Scan Now</button>
        <button id="market-copy" title="Copy diagnostic log">📋 Debug</button>
      </div>
      
      <div class="setting">
        <span>Buy Floor %:</span>
        <input type="number" id="buy-floor" value="${CFG.buyFloorPercent}" min="0" max="100">
      </div>
      
      <div class="setting">
        <span>Sell Ceil %:</span>
        <input type="number" id="sell-ceil" value="${CFG.sellCeilPercent}" min="0" max="100">
      </div>
      
      <div class="setting">
        <span>Min Funding:</span>
        <input type="number" id="min-funding" value="${CFG.minFunding}" min="0" step="100">
      </div>
      
      <div class="status" id="market-status">Open Galactic Market tab</div>
      
      <div class="stats">
        <div>Buys: <span id="buy-count">0</span></div>
        <div>Sells: <span id="sell-count">0</span></div>
      </div>
    `;

    document.body.appendChild(hudEl);

    // Wire controls
    const toggleBtn = hudEl.querySelector("#market-toggle");
    toggleBtn.classList.toggle("active", CFG.enabled);
    toggleBtn.addEventListener("click", () => {
      CFG.enabled = !CFG.enabled;
      toggleBtn.textContent = CFG.enabled ? 'STOP' : 'START';
      toggleBtn.classList.toggle("active", CFG.enabled);
      saveSettings();
      state.lastAction = CFG.enabled ? "Started" : "Stopped";
      updateHUD();
    });

    hudEl.querySelector("#market-scan").addEventListener("click", () => {
      executeTrades();
    });

    hudEl.querySelector("#market-copy").addEventListener("click", async () => {
      const diagLog = generateDiagnosticLog();
      try {
        await navigator.clipboard.writeText(diagLog);
        const btn = hudEl.querySelector("#market-copy");
        const origText = btn.textContent;
        btn.textContent = "✓ Copied";
        setTimeout(() => btn.textContent = origText, 1500);
      } catch {
        prompt("Copy this diagnostic log:", diagLog);
      }
    });

    const buyFloorInput = hudEl.querySelector("#buy-floor");
    buyFloorInput.addEventListener("change", () => {
      CFG.buyFloorPercent = Math.max(0, Math.min(100, parseInt(buyFloorInput.value) || 20));
      buyFloorInput.value = CFG.buyFloorPercent;
      saveSettings();
    });

    const sellCeilInput = hudEl.querySelector("#sell-ceil");
    sellCeilInput.addEventListener("change", () => {
      CFG.sellCeilPercent = Math.max(0, Math.min(100, parseInt(sellCeilInput.value) || 90));
      sellCeilInput.value = CFG.sellCeilPercent;
      saveSettings();
    });

    const minFundingInput = hudEl.querySelector("#min-funding");
    minFundingInput.addEventListener("change", () => {
      CFG.minFunding = Math.max(0, parseInt(minFundingInput.value) || 0);
      minFundingInput.value = CFG.minFunding;
      saveSettings();
    });
  }

  function updateHUD() {
    if (!hudEl) return;

    const statusEl = hudEl.querySelector("#market-status");
    const buyCountEl = hudEl.querySelector("#buy-count");
    const sellCountEl = hudEl.querySelector("#sell-count");

    if (statusEl) statusEl.textContent = state.lastAction || "Waiting...";
    if (buyCountEl) buyCountEl.textContent = state.trades.buys;
    if (sellCountEl) sellCountEl.textContent = state.trades.sells;
  }

  // ============ INIT ============
  function init() {
    log("Market Automator v3.0.0 starting...");
    
    createHUD();
    setInterval(tick, 200);
    
    window.ttMarketAuto = {
      config: CFG,
      state,
      executeTrades,
      findInputs: findMarketInputs,
    };

    log("Ready! Open market tab and click START");
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
