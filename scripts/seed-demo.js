#!/usr/bin/env node
'use strict';

/* ============================================================================
 * Claude Usage Dashboard · scripts/seed-demo.js
 * ----------------------------------------------------------------------------
 * Generates a believable demo-usage.db so README screenshots can be captured
 * without exposing real project names, costs, or session ids.
 *
 * Run:    node scripts/seed-demo.js
 * Then:   CLAUDE_USAGE_DB=$PWD/demo-usage.db node server.js
 * ==========================================================================*/

const { DatabaseSync } = require('node:sqlite');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const OUT = path.resolve(__dirname, '..', 'demo-usage.db');
try { fs.unlinkSync(OUT); } catch (_) {}

const db = new DatabaseSync(OUT);

db.exec(`
  CREATE TABLE sessions (
    session_id      TEXT PRIMARY KEY,
    project_name    TEXT,
    first_timestamp TEXT,
    last_timestamp  TEXT,
    git_branch      TEXT,
    total_input_tokens      INTEGER DEFAULT 0,
    total_output_tokens     INTEGER DEFAULT 0,
    total_cache_read        INTEGER DEFAULT 0,
    total_cache_creation    INTEGER DEFAULT 0,
    model           TEXT,
    turn_count      INTEGER DEFAULT 0
  );
  CREATE TABLE turns (
    id                      INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id              TEXT,
    timestamp               TEXT,
    model                   TEXT,
    input_tokens            INTEGER DEFAULT 0,
    output_tokens           INTEGER DEFAULT 0,
    cache_read_tokens       INTEGER DEFAULT 0,
    cache_creation_tokens   INTEGER DEFAULT 0,
    tool_name               TEXT,
    cwd                     TEXT,
    message_id              TEXT
  );
  CREATE TABLE processed_files (
    path    TEXT PRIMARY KEY,
    mtime   REAL,
    lines   INTEGER
  );
  CREATE INDEX idx_turns_session ON turns(session_id);
  CREATE INDEX idx_turns_ts ON turns(timestamp);
`);

// ------------------------------------------------------------ deterministic RNG
// Seeded so re-running the demo seeder produces the same screenshots.
let seed = 0x5f3759df;
function rand() {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
}
function rint(a, b) { return Math.floor(a + rand() * (b - a + 1)); }
function pick(arr) { return arr[Math.floor(rand() * arr.length)]; }
function uuid() {
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 16; i++) bytes[i] = Math.floor(rand() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const h = bytes.toString('hex');
  return `${h.slice(0,8)}-${h.slice(8,12)}-${h.slice(12,16)}-${h.slice(16,20)}-${h.slice(20)}`;
}

// ------------------------------------------------------------ catalogue
const PROJECTS = [
  { name: 'acme-corp/api',           branch: 'main',           weight: 28 },
  { name: 'acme-corp/web',           branch: 'feature/checkout', weight: 22 },
  { name: 'acme-corp/mobile',        branch: 'release/2.4',    weight: 12 },
  { name: 'personal/blog',           branch: 'draft/redesign', weight: 8 },
  { name: 'experiments/ml-pipeline', branch: 'main',           weight: 10 },
  { name: 'oss/dashboard-kit',       branch: 'next',           weight: 12 },
  { name: 'sandbox/prototype',       branch: 'main',           weight: 8 },
];

const MODELS = [
  // distribution skews Sonnet-heavy, sprinkles Opus + Haiku
  { id: 'claude-sonnet-4-5-20251022', weight: 50 },
  { id: 'claude-sonnet-4-5-20250930', weight: 8 },
  { id: 'claude-opus-4-5-20251030',   weight: 25 },
  { id: 'claude-haiku-4-5-20251015',  weight: 12 },
  { id: 'claude-3-5-haiku-20241022',  weight: 5 },
];

const NATIVE_TOOLS = [
  { name: 'Read',         weight: 30 },
  { name: 'Edit',         weight: 18 },
  { name: 'Bash',         weight: 16 },
  { name: 'Grep',         weight: 12 },
  { name: 'Glob',         weight: 8 },
  { name: 'Write',        weight: 6 },
  { name: 'TodoWrite',    weight: 5 },
  { name: 'WebFetch',     weight: 3 },
  { name: 'WebSearch',    weight: 2 },
  { name: 'NotebookEdit', weight: 1 },
];

const MCP_TOOLS = [
  { name: 'mcp__github__create_pull_request', weight: 6 },
  { name: 'mcp__github__list_issues',         weight: 4 },
  { name: 'mcp__github__get_file_contents',   weight: 5 },
  { name: 'mcp__postgres__query',             weight: 8 },
  { name: 'mcp__postgres__explain',           weight: 3 },
  { name: 'mcp__figma__get_design',           weight: 3 },
  { name: 'mcp__linear__create_ticket',       weight: 2 },
  { name: 'mcp__slack__send_message',         weight: 1 },
];

function weighted(list) {
  const total = list.reduce((a, x) => a + x.weight, 0);
  let r = rand() * total;
  for (const x of list) { r -= x.weight; if (r <= 0) return x; }
  return list[list.length - 1];
}

function pickModel() { return weighted(MODELS).id; }
function pickProject() { return weighted(PROJECTS); }
function pickTool() {
  // 18% of turns use an MCP tool
  if (rand() < 0.18) return weighted(MCP_TOOLS).name;
  // 62% native tool, 20% plain text response (no tool)
  if (rand() < 0.78) return weighted(NATIVE_TOOLS).name;
  return null;
}

// ------------------------------------------------------------ session blueprints
// Each blueprint controls health: turns count, age, peak context size.
// Health classification rules (from stats.js):
//   abandoned : ageMin >= 10080 (7d)
//   stale     : ageMin >= 1440  (1d)
//   near-max  : fill >= 0.75
//   getting   : fill >= 0.50
//   fresh     : turns <= 1 OR ctx < 5000  (or low fill + tiny + recent)
//   healthy   : everything else

const NOW = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const BLUEPRINTS = [
  // FRESH — last hour, low context, very few turns
  { ageMinutesAgo: 4,    turns: 3,    peakCtxK: 8,   project: 'acme-corp/api',           health: 'fresh' },
  { ageMinutesAgo: 22,   turns: 6,    peakCtxK: 18,  project: 'oss/dashboard-kit',       health: 'fresh' },
  { ageMinutesAgo: 48,   turns: 9,    peakCtxK: 22,  project: 'sandbox/prototype',       health: 'fresh' },

  // HEALTHY — recent, moderate fill
  { ageMinutesAgo: 90,   turns: 142,  peakCtxK: 64,  project: 'acme-corp/web',           health: 'healthy' },
  { ageMinutesAgo: 160,  turns: 88,   peakCtxK: 48,  project: 'acme-corp/api',           health: 'healthy' },
  { ageMinutesAgo: 220,  turns: 412,  peakCtxK: 96,  project: 'experiments/ml-pipeline', health: 'healthy' },
  { ageMinutesAgo: 320,  turns: 64,   peakCtxK: 38,  project: 'personal/blog',           health: 'healthy' },

  // GETTING FULL — 50–74% fill
  { ageMinutesAgo: 120,  turns: 268,  peakCtxK: 122, project: 'acme-corp/mobile',        health: 'getting-full' },
  { ageMinutesAgo: 260,  turns: 510,  peakCtxK: 138, project: 'acme-corp/api',           health: 'getting-full' },

  // NEAR MAX — ≥75% fill, still today
  { ageMinutesAgo: 75,   turns: 824,  peakCtxK: 168, project: 'acme-corp/web',           health: 'near-max' },
  { ageMinutesAgo: 360,  turns: 1180, peakCtxK: 186, project: 'oss/dashboard-kit',       health: 'near-max' },

  // STALE — 1–6 days old
  { ageMinutesAgo: 1820, turns: 220,  peakCtxK: 72,  project: 'personal/blog',           health: 'stale' },
  { ageMinutesAgo: 2880, turns: 540,  peakCtxK: 110, project: 'experiments/ml-pipeline', health: 'stale' },
  { ageMinutesAgo: 4320, turns: 90,   peakCtxK: 40,  project: 'sandbox/prototype',       health: 'stale' },

  // ABANDONED — 7+ days
  { ageMinutesAgo: 10440, turns: 320, peakCtxK: 88,  project: 'acme-corp/mobile',        health: 'abandoned' },
  { ageMinutesAgo: 13320, turns: 76,  peakCtxK: 30,  project: 'personal/blog',           health: 'abandoned' },

  // Bonus: a couple of monster sessions for "longest session" insight
  { ageMinutesAgo: 720,  turns: 2240, peakCtxK: 158, project: 'acme-corp/api',           health: 'near-max' },
  { ageMinutesAgo: 1440, turns: 1620, peakCtxK: 132, project: 'acme-corp/web',           health: 'getting-full' },

  // Older but healthy spread across 14 days for daily-activity sparkline
  { ageMinutesAgo: 600,  turns: 180,  peakCtxK: 56,  project: 'oss/dashboard-kit',       health: 'healthy' },
  { ageMinutesAgo: 880,  turns: 240,  peakCtxK: 68,  project: 'acme-corp/api',           health: 'healthy' },
  { ageMinutesAgo: 1200, turns: 410,  peakCtxK: 92,  project: 'experiments/ml-pipeline', health: 'healthy' },
  { ageMinutesAgo: 2200, turns: 320,  peakCtxK: 74,  project: 'acme-corp/web',           health: 'healthy' },
  { ageMinutesAgo: 3600, turns: 165,  peakCtxK: 52,  project: 'acme-corp/api',           health: 'healthy' },
  { ageMinutesAgo: 5040, turns: 286,  peakCtxK: 80,  project: 'acme-corp/mobile',        health: 'healthy' },
  { ageMinutesAgo: 6480, turns: 198,  peakCtxK: 60,  project: 'oss/dashboard-kit',       health: 'healthy' },
  { ageMinutesAgo: 8400, turns: 410,  peakCtxK: 102, project: 'acme-corp/api',           health: 'healthy' },
  { ageMinutesAgo: 9600, turns: 130,  peakCtxK: 44,  project: 'personal/blog',           health: 'healthy' },
];

// ------------------------------------------------------------ turn synthesis
const insertSession = db.prepare(
  `INSERT INTO sessions
   (session_id, project_name, first_timestamp, last_timestamp, git_branch,
    total_input_tokens, total_output_tokens, total_cache_read, total_cache_creation,
    model, turn_count)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);
const insertTurn = db.prepare(
  `INSERT INTO turns
   (session_id, timestamp, model, input_tokens, output_tokens,
    cache_read_tokens, cache_creation_tokens, tool_name, cwd, message_id)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
);

db.exec('BEGIN');

let totalTurns = 0;
for (const bp of BLUEPRINTS) {
  const proj = PROJECTS.find((p) => p.name === bp.project) || PROJECTS[0];
  const sid = uuid();
  const ageMs = bp.ageMinutesAgo * MIN;
  const sessionDurationMin = Math.max(
    5,
    Math.min(8 * 60, bp.turns * (1 + rand() * 2)) // ~1–3 min/turn avg
  );

  const lastTs = NOW - ageMs;
  const firstTs = lastTs - sessionDurationMin * MIN;

  // pick a dominant model for the session
  const dominantModel = pickModel();
  const peakCtx = Math.round(bp.peakCtxK * 1000);

  let totIn = 0, totOut = 0, totCR = 0, totCC = 0;

  for (let i = 0; i < bp.turns; i++) {
    const t = i / Math.max(1, bp.turns - 1);
    const ts = new Date(firstTs + t * (lastTs - firstTs)).toISOString();
    // 80% turns reuse the dominant model, 20% mix in another
    const model = rand() < 0.82 ? dominantModel : pickModel();
    const tool = pickTool();

    // Context grows over the session, peaking near the end.
    // Use an ease-out curve toward peakCtx so the LATEST turn ≈ peakCtx.
    const ramp = Math.pow(t, 0.6); // grows fast then plateaus
    const ctxNow = Math.round(peakCtx * (0.15 + 0.85 * ramp));

    // Decompose ctxNow into input/cacheRead/cacheCreation realistically.
    // Cache-read dominates after the first ~20 turns; cache-creation is the
    // initial system prompt blob; pure input is the user message delta.
    const cacheRead = Math.round(ctxNow * (0.55 + rand() * 0.30));
    const cacheCreation = i < 3
      ? Math.round(ctxNow * (0.20 + rand() * 0.10))
      : Math.round(2000 + rand() * 3000); // small re-creation here & there
    const input = Math.max(120, Math.round(ctxNow - cacheRead - cacheCreation));
    const output = Math.round(400 + rand() * (tool ? 1800 : 4200));

    totIn += input; totOut += output; totCR += cacheRead; totCC += cacheCreation;

    insertTurn.run(
      sid, ts, model,
      input, output, cacheRead, cacheCreation,
      tool, '/Users/demo/code/' + proj.name,
      'msg_' + uuid().replace(/-/g, '').slice(0, 22)
    );
    totalTurns++;
  }

  insertSession.run(
    sid, proj.name,
    new Date(firstTs).toISOString(),
    new Date(lastTs).toISOString(),
    proj.branch,
    totIn, totOut, totCR, totCC,
    dominantModel, bp.turns
  );
}

db.exec('COMMIT');
db.close();

const sizeKB = (fs.statSync(OUT).size / 1024).toFixed(1);
console.log('');
console.log(`  ✦  demo-usage.db written`);
console.log(`     path        ${OUT}`);
console.log(`     size        ${sizeKB} KB`);
console.log(`     sessions    ${BLUEPRINTS.length}`);
console.log(`     turns       ${totalTurns.toLocaleString()}`);
console.log('');
console.log(`     run:        CLAUDE_USAGE_DB=${OUT} node server.js`);
console.log('');
