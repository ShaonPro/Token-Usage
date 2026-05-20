#!/usr/bin/env node
'use strict';

/* ============================================================================
 * Claude Usage Dashboard · server.js — local HTTP server
 * ----------------------------------------------------------------------------
 * ✦  Customized by ShaonPro · https://github.com/ShaonPro
 *     Pro-grade plug-and-play: `npx github:ShaonPro/claude-usage`
 * ==========================================================================*/

/**
 * Serves the dashboard UI and a JSON stats API. Binds to 127.0.0.1 only —
 * your usage data never leaves the machine.
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { buildStats, buildSessionDetail, readLiveFromJSONL, DB_PATH } = require('./stats');

const PORT = parseInt(process.env.PORT || '47821', 10);
const HOST = process.env.HOST || '127.0.0.1';
const HTML_FILE = path.join(__dirname, 'dashboard.html');
const PORT_RETRIES = 10;
let activePort = PORT;
let portTries = 0;

function send(res, code, type, body, extra) {
  res.writeHead(code, Object.assign({ 'Content-Type': type }, extra || {}));
  res.end(body);
}

const server = http.createServer((req, res) => {
  let u;
  try {
    u = new URL(req.url, `http://${req.headers.host || HOST}`);
  } catch (_) {
    return send(res, 400, 'text/plain', 'Bad request');
  }

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
      return send(res, 200, 'application/json', JSON.stringify(data), {
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname.startsWith('/api/session/')) {
      const id = decodeURIComponent(u.pathname.slice('/api/session/'.length));
      // session_id is a UUID-shaped value; reject anything with path chars
      if (!/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
        return send(res, 400, 'application/json', JSON.stringify({ error: 'bad session id' }));
      }
      const detail = buildSessionDetail(id);
      if (!detail) {
        return send(res, 404, 'application/json', JSON.stringify({ error: 'session not found' }));
      }
      return send(res, 200, 'application/json', JSON.stringify(detail), {
        'Cache-Control': 'no-store',
      });
    }

    if (u.pathname === '/html2canvas.min.js') {
      const file = path.join(__dirname, 'html2canvas.min.js');
      if (!fs.existsSync(file)) return send(res, 404, 'text/plain', 'Not found');
      return send(res, 200, 'application/javascript; charset=utf-8',
        fs.readFileSync(file),
        { 'Cache-Control': 'public, max-age=86400, immutable' });
    }

    if (u.pathname === '/api/live') {
      // genuine real-time data — reads the latest JSONL tail bypassing usage.db
      const data = readLiveFromJSONL();
      return send(
        res,
        200,
        'application/json',
        JSON.stringify(data || { empty: true }),
        { 'Cache-Control': 'no-store' }
      );
    }

    if (u.pathname === '/api/health') {
      return send(
        res,
        200,
        'application/json',
        JSON.stringify({ ok: true, db: DB_PATH })
      );
    }

    if (u.pathname === '/favicon.ico') {
      return send(res, 204, 'text/plain', '');
    }

    send(res, 404, 'text/plain', 'Not found');
  } catch (err) {
    const isNoDb = err && err.code === 'NO_DB';
    send(
      res,
      isNoDb ? 503 : 500,
      'application/json',
      JSON.stringify({
        error: isNoDb ? err.message : String((err && err.stack) || err),
        code: (err && err.code) || 'ERROR',
      })
    );
  }
});

function openBrowser(url) {
  if (process.env.NO_OPEN) return;
  // execFile (no shell) — avoids any shell interpolation from env-derived host/port.
  try {
    if (process.platform === 'darwin') {
      execFile('open', [url], () => {});
    } else if (process.platform === 'win32') {
      execFile('cmd', ['/c', 'start', '', url], () => {});
    } else {
      execFile('xdg-open', [url], () => {});
    }
  } catch (_) {
    /* ignore — headless / SSH / no GUI is fine */
  }
}

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') {
    if (portTries < PORT_RETRIES) {
      const busy = activePort;
      portTries++;
      activePort = PORT + portTries;
      process.stderr.write(`  Port ${busy} in use, trying ${activePort}…\n`);
      server.listen(activePort, HOST);
      return;
    }
    console.error(
      `\n  No free port between ${PORT} and ${activePort}.\n` +
        `  Start on a specific port:  PORT=8090 npm start\n`
    );
    process.exit(1);
  }
  throw e;
});

server.on('listening', () => {
  const url = `http://${HOST}:${activePort}`;
  console.log(
    [
      '',
      '  \x1b[38;5;209m✦\x1b[0m  \x1b[1mClaude Usage Dashboard\x1b[0m',
      '',
      `     Dashboard   \x1b[38;5;209m${url}\x1b[0m`,
      `     Data        \x1b[38;5;245m${DB_PATH}\x1b[0m`,
      '     Stop        \x1b[38;5;245mCtrl+C\x1b[0m',
      '',
    ].join('\n')
  );
  openBrowser(url);
});

server.listen(activePort, HOST);
