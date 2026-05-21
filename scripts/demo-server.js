#!/usr/bin/env node
'use strict';

/* ============================================================================
 * scripts/demo-server.js  —  serves the dashboard against demo-usage.db AND
 * intercepts /api/live with a canned fake feed so README screenshots never
 * leak real session activity. Run this instead of server.js when capturing.
 * ==========================================================================*/

process.env.CLAUDE_USAGE_DB =
  process.env.CLAUDE_USAGE_DB ||
  require('path').resolve(__dirname, '..', 'demo-usage.db');
process.env.NO_OPEN = '1';
process.env.PORT = process.env.PORT || '47831';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { buildStats, buildSessionDetail, DB_PATH } = require('../stats');

const PORT = parseInt(process.env.PORT, 10);
const HOST = '127.0.0.1';
const HTML_FILE = path.join(__dirname, '..', 'dashboard.html');

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type }, extra || {}));
  res.end(body);
}

// --- canned demo /api/live data ------------------------------------------------
function demoLive() {
  const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
  return {
    asOf: new Date().toISOString(),
    count: 2,
    sessions: [
      {
        sessionId: '7b3e2a91-8f4d-4c0a-9e1b-2c5f8d6e3a47',
        cwd: '/Users/demo/code/acme-corp/api',
        project: 'acme-corp/api',
        branch: 'main',
        model: 'claude-sonnet-4-5-20251022',
        modelDisplay: 'Sonnet 4.5',
        last: ago(8),
        kind: 'main',
        filePath: '/Users/demo/.claude/projects/acme-corp-api/7b3e2a91.jsonl',
        fileMtime: ago(8),
        ageMs: 8000,
        turnCount: 18,
        turns: [
          { ts: ago(8),   tool: 'Edit', model: 'claude-sonnet-4-5-20251022', modelDisplay: 'Sonnet 4.5', input: 380, output: 1840, cacheRead: 38420, cacheCreation: 1200, totalTokens: 41840, cost: 0.025 },
          { ts: ago(35),  tool: 'Read', model: 'claude-sonnet-4-5-20251022', modelDisplay: 'Sonnet 4.5', input: 240, output: 980,  cacheRead: 36100, cacheCreation: 0,    totalTokens: 37320, cost: 0.018 },
          { ts: ago(62),  tool: 'Bash', model: 'claude-sonnet-4-5-20251022', modelDisplay: 'Sonnet 4.5', input: 310, output: 1420, cacheRead: 34800, cacheCreation: 0,    totalTokens: 36530, cost: 0.022 },
          { ts: ago(98),  tool: 'Grep', model: 'claude-sonnet-4-5-20251022', modelDisplay: 'Sonnet 4.5', input: 280, output: 720,  cacheRead: 33100, cacheCreation: 0,    totalTokens: 34100, cost: 0.014 },
          { ts: ago(140), tool: 'mcp__postgres__query', model: 'claude-sonnet-4-5-20251022', modelDisplay: 'Sonnet 4.5', input: 360, output: 1980, cacheRead: 31900, cacheCreation: 0, totalTokens: 34240, cost: 0.029 },
          { ts: ago(180), tool: 'Read', model: 'claude-sonnet-4-5-20251022', modelDisplay: 'Sonnet 4.5', input: 220, output: 540,  cacheRead: 30200, cacheCreation: 0, totalTokens: 30960, cost: 0.013 },
        ],
        last5: { turns: 6, tools: 5, tokens: 215000, cost: 0.12 },
      },
      {
        sessionId: 'd9c7e3b2-1a5f-46e8-bd14-7f3a9c2e5810',
        cwd: '/Users/demo/code/acme-corp/web',
        project: 'acme-corp/web',
        branch: 'feature/checkout',
        model: 'claude-opus-4-5-20251030',
        modelDisplay: 'Opus 4.5',
        last: ago(34),
        kind: 'main',
        filePath: '/Users/demo/.claude/projects/acme-corp-web/d9c7e3b2.jsonl',
        fileMtime: ago(34),
        ageMs: 34000,
        turnCount: 9,
        turns: [
          { ts: ago(34),  tool: 'Write', model: 'claude-opus-4-5-20251030', modelDisplay: 'Opus 4.5', input: 520, output: 2840, cacheRead: 88100, cacheCreation: 2400, totalTokens: 93860, cost: 0.085 },
          { ts: ago(78),  tool: 'Edit',  model: 'claude-opus-4-5-20251030', modelDisplay: 'Opus 4.5', input: 410, output: 1620, cacheRead: 84200, cacheCreation: 0,    totalTokens: 86230, cost: 0.061 },
          { ts: ago(120), tool: 'mcp__github__create_pull_request', model: 'claude-opus-4-5-20251030', modelDisplay: 'Opus 4.5', input: 480, output: 1980, cacheRead: 82400, cacheCreation: 0, totalTokens: 84860, cost: 0.076 },
          { ts: ago(160), tool: 'TodoWrite', model: 'claude-opus-4-5-20251030', modelDisplay: 'Opus 4.5', input: 320, output: 880,  cacheRead: 79800, cacheCreation: 0, totalTokens: 81000, cost: 0.042 },
          { ts: ago(210), tool: 'Read', model: 'claude-opus-4-5-20251030', modelDisplay: 'Opus 4.5', input: 280, output: 620,  cacheRead: 77100, cacheCreation: 0, totalTokens: 78000, cost: 0.030 },
        ],
        last5: { turns: 5, tools: 5, tokens: 423000, cost: 0.29 },
      },
    ],
    activeFiles: [],
  };
}

const server = http.createServer((req, res) => {
  let u;
  try { u = new URL(req.url, `http://${req.headers.host || HOST}`); }
  catch (_) { return send(res, 400, 'text/plain', 'Bad request'); }

  try {
    if (u.pathname === '/' || u.pathname === '/index.html') {
      return send(res, 200, 'text/html; charset=utf-8', fs.readFileSync(HTML_FILE));
    }
    if (u.pathname === '/api/stats') {
      const data = buildStats({
        project: u.searchParams.get('project') || 'all',
        range: u.searchParams.get('range') || 'all',
        since: u.searchParams.get('since') || undefined,
        until: u.searchParams.get('until') || undefined,
      });
      return send(res, 200, 'application/json', JSON.stringify(data), { 'Cache-Control': 'no-store' });
    }
    if (u.pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/session/'.length));
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id))
        return send(res, 400, 'application/json', JSON.stringify({ error: 'bad session id' }));
      const detail = buildSessionDetail(id);
      if (!detail) return send(res, 404, 'application/json', JSON.stringify({ error: 'not found' }));
      return send(res, 200, 'application/json', JSON.stringify(detail), { 'Cache-Control': 'no-store' });
    }
    if (u.pathname === '/api/live') {
      // ALWAYS return canned demo data — that is the whole point of this script.
      return send(res, 200, 'application/json', JSON.stringify(demoLive()), { 'Cache-Control': 'no-store' });
    }
    if (u.pathname === '/api/health') {
      return send(res, 200, 'application/json', JSON.stringify({ ok: true, db: DB_PATH, demo: true }));
    }
    if (u.pathname === '/favicon.ico') return send(res, 204, 'text/plain', '');
    if (u.pathname === '/__upload' && req.method === 'POST') {
      // demo-only endpoint to save capture blobs to disk
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
          const name = String(body.name || '').replace(/[^a-zA-Z0-9._-]/g, '');
          if (!name) return send(res, 400, 'application/json', JSON.stringify({ error: 'bad name' }));
          const m = String(body.dataUrl || '').match(/^data:image\/(png|jpeg|webp);base64,(.+)$/);
          if (!m) return send(res, 400, 'application/json', JSON.stringify({ error: 'bad dataUrl' }));
          const dir = path.join(__dirname, '..', 'screenshots');
          if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
          const out = path.join(dir, name);
          fs.writeFileSync(out, Buffer.from(m[2], 'base64'));
          send(res, 200, 'application/json', JSON.stringify({ ok: true, path: out, size: fs.statSync(out).size }));
        } catch (e) {
          send(res, 500, 'application/json', JSON.stringify({ error: String(e.message || e) }));
        }
      });
      return;
    }
    send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    send(res, 500, 'application/json', JSON.stringify({ error: String(err && err.message || err) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`\n  ✦  demo-server  http://${HOST}:${PORT}\n     db   ${DB_PATH}\n`);
});
