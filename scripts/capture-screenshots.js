#!/usr/bin/env node
'use strict';

/* ============================================================================
 * scripts/capture-screenshots.js
 * Headless Chrome + DevTools Protocol → high-res README screenshots.
 * Drives the demo server (47831) and writes PNGs into screenshots/.
 * Run:  node scripts/capture-screenshots.js
 * ==========================================================================*/

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const DEBUG_PORT = 9333;
const URL = process.env.DASH_URL || 'http://127.0.0.1:47831/';
const OUT_DIR = path.resolve(__dirname, '..', 'screenshots');
fs.mkdirSync(OUT_DIR, { recursive: true });

const WIDTH = 1600;
const HEIGHT = 1100;

function httpGetJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

(async () => {
  // 1. spawn Chrome
  const userDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'chr-shot-'));
  console.log('[chrome] launching');
  const chrome = spawn(CHROME, [
    `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${userDir}`,
    '--headless=new',
    '--disable-gpu',
    '--hide-scrollbars',
    '--no-first-run',
    '--no-default-browser-check',
    `--window-size=${WIDTH},${HEIGHT}`,
    'about:blank',
  ], { stdio: ['ignore', 'pipe', 'pipe'] });
  chrome.stderr.on('data', () => {}); // silence GPU noise

  // 2. wait for debugger
  let targets = null;
  for (let i = 0; i < 40 && !targets; i++) {
    await sleep(150);
    try {
      const j = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
      const list = await httpGetJson(`http://127.0.0.1:${DEBUG_PORT}/json`);
      if (j && list && list.length) { targets = { v: j, list }; }
    } catch (_) { /* not up yet */ }
  }
  if (!targets) { chrome.kill(); throw new Error('Chrome debugger did not come up'); }
  const target = targets.list.find((t) => t.type === 'page') || targets.list[0];
  console.log('[chrome] connected, target=' + target.id);

  // 3. open CDP websocket
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
  let nextId = 1;
  const pending = new Map();
  const events = new Map();
  ws.onmessage = (msg) => {
    const j = JSON.parse(msg.data);
    if (j.id != null && pending.has(j.id)) {
      const { resolve, reject } = pending.get(j.id);
      pending.delete(j.id);
      if (j.error) reject(new Error(`CDP ${j.error.code}: ${j.error.message}`));
      else resolve(j.result);
    } else if (j.method) {
      const list = events.get(j.method) || [];
      events.set(j.method, []);
      for (const cb of list) cb(j.params);
    }
  };
  function send(method, params = {}) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  }
  function once(method) {
    return new Promise((res) => {
      const list = events.get(method) || [];
      list.push(res);
      events.set(method, list);
    });
  }

  // 4. enable domains, navigate
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Network.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: WIDTH, height: HEIGHT, deviceScaleFactor: 2, mobile: false,
  });
  const loaded = once('Page.loadEventFired');
  await send('Page.navigate', { url: URL });
  await loaded;
  console.log('[chrome] loaded ' + URL);

  // 5. wait for hydration (>= 12 cards in DOM)
  for (let i = 0; i < 60; i++) {
    const r = await send('Runtime.evaluate', {
      expression: 'document.querySelectorAll(".card").length',
      returnByValue: true,
    });
    if ((r.result.value || 0) >= 12) break;
    await sleep(200);
  }
  // small extra delay for chart animations to settle
  await sleep(800);
  console.log('[chrome] dashboard hydrated');

  // helper: scroll a selector into view + capture clipped to its bounding rect.
  // Use captureBeyondViewport so clip is in PAGE coordinates and works for
  // cards taller than the viewport.
  async function captureCard(selector, filename) {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return null;
        const rb = el.getBoundingClientRect();
        const x = Math.max(0, rb.left + window.scrollX);
        const y = Math.max(0, rb.top + window.scrollY);
        return { x, y, w: rb.width, h: rb.height };
      })()`,
      returnByValue: true,
    });
    if (!r.result.value) { console.warn('[skip]', selector); return; }
    await sleep(150);
    const c = r.result.value;
    const out = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: c.x, y: c.y, width: c.w, height: c.h, scale: 2 },
    });
    const buf = Buffer.from(out.data, 'base64');
    fs.writeFileSync(path.join(OUT_DIR, filename), buf);
    console.log(`[saved] ${filename}  ${(buf.length/1024).toFixed(0)} KB  ${c.w}×${c.h}`);
  }

  // also: full top-of-page capture (header + KPIs + live monitor) for hero
  async function captureFullTop(filename, untilSelector) {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{
        window.scrollTo(0, 0);
        const el = document.querySelector(${JSON.stringify(untilSelector)});
        const r = el ? el.getBoundingClientRect() : { bottom: 900 };
        return { h: Math.max(800, Math.min(2400, r.bottom + 24)) };
      })()`,
      returnByValue: true,
    });
    const h = r.result.value.h;
    await sleep(300);
    const out = await send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: true,
      clip: { x: 0, y: 0, width: WIDTH, height: h, scale: 2 },
    });
    const buf = Buffer.from(out.data, 'base64');
    fs.writeFileSync(path.join(OUT_DIR, filename), buf);
    console.log(`[saved] ${filename}  ${(buf.length/1024).toFixed(0)} KB  ${WIDTH}×${h}`);
  }

  // 6. capture suite
  // identify cards by their <h3> text since none have ids
  async function selByTitle(title) {
    const r = await send('Runtime.evaluate', {
      expression: `(()=>{
        const all=[...document.querySelectorAll('.card')];
        const m=all.find(c=>{
          const h=c.querySelector('h2,h3,.h,.card-title,.title');
          return h && h.textContent.trim().toLowerCase().includes(${JSON.stringify(title.toLowerCase())});
        });
        if(!m) return null;
        m.setAttribute('data-shot', ${JSON.stringify(title)});
        return '.card[data-shot=' + JSON.stringify(${JSON.stringify(title)}) + ']';
      })()`,
      returnByValue: true,
    });
    return r.result.value;
  }

  await captureFullTop('hero.png', '.card');     // header + KPIs + live monitor
  await captureCard(await selByTitle('Live monitor'),       'live-monitor.png');
  await captureCard(await selByTitle('Where to keep working'), 'advisor.png');
  await captureCard(await selByTitle('Monthly forecast'),   'forecast.png');
  await captureCard(await selByTitle('Token optimization'), 'optimization.png');
  await captureCard(await selByTitle('Activity over time'), 'chart.png');
  await captureCard(await selByTitle('Model breakdown'),    'models.png');
  await captureCard(await selByTitle('Cache efficiency'),   'cache.png');
  await captureCard(await selByTitle('Projects'),           'projects.png');
  await captureCard(await selByTitle('Tool usage'),         'tools.png');
  await captureCard(await selByTitle('MCP servers'),        'mcp-servers.png');
  await captureCard(await selByTitle('Daily activity'),     'daily-activity.png');
  await captureCard(await selByTitle('Insights'),           'insights.png');
  await captureCard(await selByTitle('Sessions'),           'sessions.png');

  // 7. shutdown
  try { ws.close(); } catch (_) {}
  chrome.kill();
  // best-effort cleanup
  try { fs.rmSync(userDir, { recursive: true, force: true }); } catch (_) {}
  console.log('\n  ✦  done. screenshots in ' + OUT_DIR + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
