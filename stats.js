'use strict';

/* ============================================================================
 * Claude Usage Dashboard · stats.js — data layer
 * ----------------------------------------------------------------------------
 * ✦  Customized by ShaonPro · https://github.com/ShaonPro
 *     "Pro" signature is sprinkled through the codebase. Type p-r-o on the
 *     dashboard to see it.
 * ==========================================================================*/

/**
 * Reads ~/.claude/usage.db (read-only) plus the real-time JSONL transcripts
 * and produces a single aggregated stats object consumed by both the web
 * server and the CLI. Pro tip — every endpoint here is filter-aware.
 */

const SHAON_PRO = Object.freeze({
  name: 'ShaonPro',
  github: 'https://github.com/ShaonPro',
  sig: '✦',
});

// node:sqlite is built into Node, but the rollout history is awkward:
//   Node 22.5  – 22.6   exists, needs --experimental-sqlite flag
//   Node 22.7  – 22.x   stable, no flag
//   Node 23                stable
//   Node 24+               stable (recommended)
// We try to load it; if that fails we self-relaunch with the flag once
// (so the user doesn't have to know which Node version they have).
let DatabaseSync;
try {
  ({ DatabaseSync } = require('node:sqlite'));
} catch (err) {
  const nodeVer = process.versions.node;
  const [maj, min] = nodeVer.split('.').map(Number);
  const isFlagRequiredRange =
    (maj === 22 && min >= 5 && min <= 6) ||
    /experimental/i.test(String(err && err.message));
  const alreadyRetried = process.env._CU_SQLITE_RETRY === '1';

  if (isFlagRequiredRange && !alreadyRetried) {
    // Self-relaunch with --experimental-sqlite so end users don't have to
    // figure out which CLI flag their Node version needs.
    const { spawnSync } = require('child_process');
    const args = ['--experimental-sqlite', ...process.argv.slice(1)];
    process.stderr.write(
      `\n  Node ${nodeVer} needs --experimental-sqlite for node:sqlite. Relaunching…\n\n`
    );
    const r = spawnSync(process.execPath, args, {
      stdio: 'inherit',
      env: { ...process.env, _CU_SQLITE_RETRY: '1' },
    });
    process.exit(r.status == null ? 1 : r.status);
  }

  console.error(
    `\n  Failed to load node:sqlite on Node ${nodeVer}.\n` +
      `  The Claude Usage Dashboard needs the built-in node:sqlite module.\n\n` +
      `  Easiest fix — upgrade Node to 22.7+ or 24+:\n` +
      `      https://nodejs.org\n\n` +
      `  Or rerun manually with the experimental flag:\n` +
      `      node --experimental-sqlite ${process.argv[1] || 'server.js'}\n\n` +
      `  Underlying error: ${err && err.message}\n`
  );
  process.exit(1);
}
const os = require('os');
const path = require('path');
const fs = require('fs');

const DB_PATH =
  process.env.CLAUDE_USAGE_DB || path.join(os.homedir(), '.claude', 'usage.db');

// Anthropic API list prices in USD per 1M tokens. Claude Code subscription
// users are NOT billed this — it is shown as an "equivalent API cost" so you
// can see the dollar value of the work you ran locally.
const PRICING = {
  'claude-opus-4-7':   { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-6':   { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4-5':   { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus-4':     { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-opus':       { in: 15,  out: 75, cacheRead: 1.5,  cacheWrite: 18.75 },
  'claude-sonnet-4-6': { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4-5': { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet-4':   { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-sonnet':     { in: 3,   out: 15, cacheRead: 0.3,  cacheWrite: 3.75 },
  'claude-haiku-4-5':  { in: 1,   out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
  'claude-haiku-4':    { in: 1,   out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
  'claude-3-5-haiku':  { in: 0.8, out: 4,  cacheRead: 0.08, cacheWrite: 1 },
  'claude-haiku':      { in: 1,   out: 5,  cacheRead: 0.1,  cacheWrite: 1.25 },
};
const DEFAULT_PRICE = { in: 3, out: 15, cacheRead: 0.3, cacheWrite: 3.75 };

const RANGES = { '7d': 7, '14d': 14, '30d': 30, '90d': 90 };

// Standard Claude model context window (tokens). Used to gauge how full the
// most recent session's context is.
const CONTEXT_WINDOW = 200000;

function priceFor(model) {
  if (!model) return DEFAULT_PRICE;
  if (PRICING[model]) return PRICING[model];
  let best = DEFAULT_PRICE;
  let bestLen = 0;
  for (const key in PRICING) {
    if (model.startsWith(key) && key.length > bestLen) {
      best = PRICING[key];
      bestLen = key.length;
    }
  }
  return best;
}

function costOf(model, t) {
  const p = priceFor(model);
  return (
    ((t.input || 0) / 1e6) * p.in +
    ((t.output || 0) / 1e6) * p.out +
    ((t.cacheRead || 0) / 1e6) * p.cacheRead +
    ((t.cacheCreation || 0) / 1e6) * p.cacheWrite
  );
}

function prettyModel(m) {
  if (!m || m === 'unknown') return 'Unknown';
  let s = m.replace(/^claude-/, '').replace(/-\d{6,}$/, '');
  const parts = s.split('-');
  const fam = parts.shift() || '';
  const ver = parts.join('.');
  const famName = fam.charAt(0).toUpperCase() + fam.slice(1);
  return ver ? `${famName} ${ver}` : famName;
}

function localDate(d) {
  return (
    d.getFullYear() +
    '-' +
    String(d.getMonth() + 1).padStart(2, '0') +
    '-' +
    String(d.getDate()).padStart(2, '0')
  );
}
function shortDay(key) {
  return new Date(key + 'T12:00:00').toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });
}
function hourLabel(h) {
  if (h === 0) return '12 AM';
  if (h === 12) return '12 PM';
  return h < 12 ? `${h} AM` : `${h - 12} PM`;
}

function emptyAgg() {
  return { turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0, cost: 0, toolCalls: 0 };
}
function addAgg(a, t, c) {
  a.turns++;
  a.input += t.input;
  a.output += t.output;
  a.cacheRead += t.cacheRead;
  a.cacheCreation += t.cacheCreation;
  a.cost += c;
}
function totalTokens(a) {
  return a.input + a.output + a.cacheRead + a.cacheCreation;
}

function buildStats(opts = {}) {
  if (!fs.existsSync(DB_PATH)) {
    const e = new Error(`Claude usage database not found at ${DB_PATH}`);
    e.code = 'NO_DB';
    throw e;
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    return compute(db, opts);
  } finally {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
  }
}

function compute(db, opts) {
  const allProjects = db
    .prepare(
      "SELECT DISTINCT project_name p FROM sessions WHERE project_name IS NOT NULL AND project_name <> '' ORDER BY 1"
    )
    .all()
    .map((r) => r.p);

  const span =
    db
      .prepare('SELECT MIN(first_timestamp) a, MAX(last_timestamp) b FROM sessions')
      .get() || { a: null, b: null };

  const range = RANGES[opts.range] ? opts.range : 'all';
  let since = opts.since || null;
  let until = opts.until || null;
  if (!since && RANGES[range] && span.b) {
    since = new Date(
      new Date(span.b).getTime() - RANGES[range] * 86400000
    ).toISOString();
  }
  let project = 'all';
  if (opts.project && opts.project !== 'all' && allProjects.includes(opts.project)) {
    project = opts.project;
  }

  const where = [];
  const params = [];
  if (project !== 'all') {
    where.push('s.project_name = ?');
    params.push(project);
  }
  if (since) {
    where.push('t.timestamp >= ?');
    params.push(since);
  }
  if (until) {
    where.push('t.timestamp <= ?');
    params.push(until);
  }
  const W = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const rows = db
    .prepare(
      `SELECT t.session_id sid, t.timestamp ts, t.model model,
              t.input_tokens inp, t.output_tokens outp,
              t.cache_read_tokens cr, t.cache_creation_tokens cc,
              t.tool_name tool, s.project_name project, s.git_branch branch
         FROM turns t
         JOIN sessions s ON t.session_id = s.session_id
         ${W}
        ORDER BY t.timestamp ASC`
    )
    .all(...params);

  const totals = emptyAgg();
  totals.toolCalls = 0;
  const byModel = new Map();
  const byProject = new Map();
  const byDay = new Map();
  const byTool = new Map();
  const bySession = new Map();
  const byHour = new Array(24).fill(0);
  const byWeekday = new Array(7).fill(0);
  const activeDays = new Set();

  for (const r of rows) {
    const tok = {
      input: r.inp || 0,
      output: r.outp || 0,
      cacheRead: r.cr || 0,
      cacheCreation: r.cc || 0,
    };
    const model = r.model || 'unknown';
    const c = costOf(model, tok);
    addAgg(totals, tok, c);
    if (r.tool) {
      totals.toolCalls++;
      byTool.set(r.tool, (byTool.get(r.tool) || 0) + 1);
    }

    const d = new Date(r.ts);
    const day = localDate(d);
    activeDays.add(day);
    byHour[d.getHours()]++;
    byWeekday[d.getDay()]++;

    if (!byModel.has(model)) byModel.set(model, emptyAgg());
    addAgg(byModel.get(model), tok, c);

    const pname = r.project || '(unknown)';
    if (!byProject.has(pname))
      byProject.set(pname, { agg: emptyAgg(), sessions: new Set() });
    const pp = byProject.get(pname);
    addAgg(pp.agg, tok, c);
    pp.sessions.add(r.sid);

    if (!byDay.has(day)) byDay.set(day, emptyAgg());
    addAgg(byDay.get(day), tok, c);
    if (r.tool) byDay.get(day).toolCalls++;

    if (!bySession.has(r.sid)) {
      bySession.set(r.sid, {
        id: r.sid,
        project: pname,
        branch: r.branch || '',
        first: r.ts,
        last: r.ts,
        agg: emptyAgg(),
        models: new Map(),
        tools: 0,
        lastTurn: null,
      });
    }
    const ss = bySession.get(r.sid);
    if (r.ts < ss.first) ss.first = r.ts;
    if (r.ts > ss.last) ss.last = r.ts;
    addAgg(ss.agg, tok, c);
    ss.models.set(model, (ss.models.get(model) || 0) + 1);
    if (r.tool) ss.tools++;
    // rows are ORDER BY timestamp ASC, so this lands on the latest turn
    if (!ss.lastTurn || r.ts >= ss.lastTurn.ts) {
      ss.lastTurn = {
        ts: r.ts,
        tool: r.tool || '',
        model,
        input: tok.input,
        output: tok.output,
        cacheRead: tok.cacheRead,
        cacheCreation: tok.cacheCreation,
      };
    }
  }
  totals.sessions = bySession.size;
  totals.totalTokens = totalTokens(totals);

  const byModelArr = [...byModel]
    .map(([model, a]) => ({
      model,
      display: prettyModel(model),
      ...a,
      totalTokens: totalTokens(a),
      share: rows.length ? a.turns / rows.length : 0,
    }))
    .sort((x, y) => y.cost - x.cost);

  const byProjectArr = [...byProject]
    .map(([projectName, v]) => ({
      project: projectName,
      sessions: v.sessions.size,
      ...v.agg,
      totalTokens: totalTokens(v.agg),
    }))
    .sort((x, y) => y.cost - x.cost);

  const byDayArr = fillDays(byDay);

  const byToolArr = [...byTool]
    .map(([tool, count]) => ({ tool, count }))
    .sort((a, b) => b.count - a.count);

  // group mcp__SERVER__tool calls by their MCP server
  const mcpMap = new Map();
  for (const t of byToolArr) {
    if (!t.tool.startsWith('mcp__')) continue;
    const parts = t.tool.split('__');
    const server = parts[1] || 'unknown';
    const tname = parts.slice(2).join('__') || t.tool;
    if (!mcpMap.has(server)) mcpMap.set(server, { server, calls: 0, tools: [] });
    const s = mcpMap.get(server);
    s.calls += t.count;
    s.tools.push({ tool: tname, count: t.count, fullName: t.tool });
  }
  const byMcpServer = [...mcpMap.values()].sort((a, b) => b.calls - a.calls);
  const nativeToolCalls = byToolArr
    .filter((t) => !t.tool.startsWith('mcp__'))
    .reduce((a, t) => a + t.count, 0);
  const mcpToolCalls = byMcpServer.reduce((a, s) => a + s.calls, 0);

  const sessionsArr = [...bySession.values()]
    .map((s) => {
      let domModel = 'unknown';
      let domN = -1;
      for (const [m, n] of s.models) {
        if (n > domN) {
          domN = n;
          domModel = m;
        }
      }
      const lt = s.lastTurn || { input: 0, output: 0, cacheRead: 0, cacheCreation: 0, tool: '' };
      const lastContext = lt.input + lt.cacheRead + lt.cacheCreation;
      return {
        id: s.id,
        idShort: s.id.slice(0, 8),
        project: s.project,
        branch: s.branch,
        model: domModel,
        modelDisplay: prettyModel(domModel),
        modelCount: s.models.size,
        first: s.first,
        last: s.last,
        durationMin: Math.max(0, ((new Date(s.last) - new Date(s.first)) / 60000) || 0),
        turns: s.agg.turns,
        input: s.agg.input,
        output: s.agg.output,
        cacheRead: s.agg.cacheRead,
        cacheCreation: s.agg.cacheCreation,
        totalTokens: totalTokens(s.agg),
        cost: s.agg.cost,
        toolCalls: s.tools,
        lastContext,
        lastTool: lt.tool || '',
      };
    })
    .sort((a, b) => new Date(b.last) - new Date(a.last));

  // attach per-day session-start counts to byDayArr
  const sessionStartByDay = {};
  for (const s of sessionsArr) {
    const k = localDate(new Date(s.first));
    sessionStartByDay[k] = (sessionStartByDay[k] || 0) + 1;
  }
  for (const dd of byDayArr) dd.sessions = sessionStartByDay[dd.day] || 0;

  const recent = rows
    .slice(-60)
    .reverse()
    .map((r) => {
      const tok = {
        input: r.inp || 0,
        output: r.outp || 0,
        cacheRead: r.cr || 0,
        cacheCreation: r.cc || 0,
      };
      return {
        sid: r.sid.slice(0, 8),
        ts: r.ts,
        model: r.model || 'unknown',
        modelDisplay: prettyModel(r.model || 'unknown'),
        tool: r.tool || '',
        project: r.project || '(unknown)',
        ...tok,
        totalTokens: tok.input + tok.output + tok.cacheRead + tok.cacheCreation,
        cost: costOf(r.model, tok),
      };
    });

  let cacheSavings = 0;
  for (const [model, a] of byModel) {
    const p = priceFor(model);
    cacheSavings += (a.cacheRead / 1e6) * (p.in - p.cacheRead);
  }
  const cacheBase = totals.cacheRead + totals.cacheCreation + totals.input;
  const cacheHitRate = cacheBase ? totals.cacheRead / cacheBase : 0;

  // The context window is an account-level property, so infer it from the
  // largest prompt ever seen (unfiltered): a >200K prompt means the 1M tier.
  const gp = db
    .prepare(
      'SELECT MAX(cache_read_tokens + cache_creation_tokens + input_tokens) m FROM turns'
    )
    .get();
  const contextWindow =
    gp && gp.m > CONTEXT_WINDOW ? 1000000 : CONTEXT_WINDOW;

  // ---- per-session health classification ----
  const NOW_TS = Date.now();
  for (const s of sessionsArr) {
    const fill = contextWindow ? s.lastContext / contextWindow : 0;
    const ageMin = (NOW_TS - new Date(s.last)) / 60000;
    const h = classifyHealth({ fill, ageMin, turns: s.turns, ctx: s.lastContext });
    s.contextFill = fill;
    s.ageMin = ageMin;
    s.health = h.health;
    s.healthTone = h.tone;
    s.healthMessage = h.message;
  }

  // ---- per-project advisor (which session to keep using, when to start fresh) ----
  const HEALTH_ORDER = {
    fresh: 0, healthy: 1, 'getting-full': 2, 'near-max': 3, stale: 4, abandoned: 5,
  };
  const advMap = new Map();
  for (const s of sessionsArr) {
    const k = s.project || '(unknown)';
    if (!advMap.has(k))
      advMap.set(k, {
        project: k,
        sessions: [],
        counts: { fresh:0, healthy:0, 'getting-full':0, 'near-max':0, stale:0, abandoned:0 },
      });
    const p = advMap.get(k);
    p.sessions.push(s);
    p.counts[s.health] = (p.counts[s.health] || 0) + 1;
  }
  const projectAdvice = [...advMap.values()].map((p) => {
    let best = null;
    let bestScore = Infinity;
    for (const s of p.sessions) {
      if (!['fresh', 'healthy', 'getting-full'].includes(s.health)) continue;
      const score = s.contextFill * 100 + s.ageMin / 60 + s.turns * 0.5;
      if (score < bestScore) { bestScore = score; best = s; }
    }
    p.sessions.sort((a, b) => {
      const oa = HEALTH_ORDER[a.health] ?? 9;
      const ob = HEALTH_ORDER[b.health] ?? 9;
      if (oa !== ob) return oa - ob;
      return (a.ageMin || 0) - (b.ageMin || 0);
    });
    const c = p.counts;
    const total = p.sessions.length;
    const staleCount = (c.stale || 0) + (c.abandoned || 0);
    let summary, needsNew = false;
    if (staleCount === total) {
      summary = 'Project dormant — start fresh if resuming';
      needsNew = true;
    } else if (!best) {
      summary = 'All sessions full — start a fresh session';
      needsNew = true;
    } else {
      const parts = [];
      if (c.fresh) parts.push(`${c.fresh} fresh`);
      if (c.healthy) parts.push(`${c.healthy} healthy`);
      if (c['getting-full']) parts.push(`${c['getting-full']} getting full`);
      if (c['near-max']) parts.push(`${c['near-max']} near max`);
      if (c.stale) parts.push(`${c.stale} stale`);
      summary = `${parts.join(', ') || 'fresh start'} — continue ${best.idShort}`;
    }
    return {
      project: p.project,
      total,
      counts: c,
      totals: {
        turns: p.sessions.reduce((a, s) => a + (s.turns || 0), 0),
        cost: p.sessions.reduce((a, s) => a + (s.cost || 0), 0),
        tokens: p.sessions.reduce((a, s) => a + (s.totalTokens || 0), 0),
      },
      best: best
        ? { id: best.id, idShort: best.idShort, contextFill: best.contextFill,
            ageMin: best.ageMin, turns: best.turns, cost: best.cost }
        : null,
      needsNew,
      summary,
      sessionIds: p.sessions.slice(0, 6).map((s) => ({
        id: s.id, idShort: s.idShort, health: s.health, healthTone: s.healthTone,
        healthMessage: s.healthMessage, contextFill: s.contextFill, ageMin: s.ageMin,
        turns: s.turns, cost: s.cost,
      })),
    };
  }).sort((a, b) => b.total - a.total);

  // ---- forecast: this calendar month projection ----
  // Always uses UNFILTERED data so the forecast is meaningful regardless
  // of the current project/range filter.
  const now = new Date();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
  const sevenAgo = new Date(now.getTime() - 7 * 86400000).toISOString();
  function modelSumCost(sinceTs) {
    const rows = db
      .prepare(
        `SELECT model, SUM(input_tokens) inp, SUM(output_tokens) outp,
                SUM(cache_read_tokens) cr, SUM(cache_creation_tokens) cc
           FROM turns WHERE timestamp >= ? GROUP BY model`
      )
      .all(sinceTs);
    let c = 0;
    for (const r of rows) {
      c += costOf(r.model, {
        input: r.inp || 0,
        output: r.outp || 0,
        cacheRead: r.cr || 0,
        cacheCreation: r.cc || 0,
      });
    }
    return c;
  }
  const monthToDateCost = modelSumCost(monthStart);
  const recent7Cost = modelSumCost(sevenAgo);
  const daysInMonth = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysIntoMonth = now.getDate();
  const daysRemaining = Math.max(0, daysInMonth - daysIntoMonth);
  const recentDailyRate = recent7Cost / 7;
  const forecast = {
    monthToDateCost,
    recentDailyRate,
    daysIntoMonth,
    daysInMonth,
    daysRemaining,
    projectedMonthEnd: monthToDateCost + recentDailyRate * daysRemaining,
    monthLabel: now.toLocaleString('en-US', { month: 'long', year: 'numeric' }),
  };

  // most-recent session + its context-window usage
  let live = null;
  if (rows.length) {
    const liveSid = rows[rows.length - 1].sid;
    const liveRows = rows.filter((r) => r.sid === liveSid);
    const ls = bySession.get(liveSid);
    const ctxSeries = liveRows.map((r) => (r.cr || 0) + (r.cc || 0) + (r.inp || 0));
    const lastRow = liveRows[liveRows.length - 1];
    let dm = 'unknown', dn = -1;
    for (const [m, n] of ls.models) if (n > dn) { dn = n; dm = m; }
    live = {
      sessionId: liveSid,
      project: ls.project,
      branch: ls.branch,
      model: dm,
      modelDisplay: prettyModel(dm),
      first: ls.first,
      last: ls.last,
      turns: ls.agg.turns,
      toolCalls: ls.tools,
      cost: ls.agg.cost,
      durationMin: Math.max(0, ((new Date(ls.last) - new Date(ls.first)) / 60000) || 0),
      contextWindow,
      currentContext: ctxSeries[ctxSeries.length - 1] || 0,
      peakContext: ctxSeries.length ? Math.max(...ctxSeries) : 0,
      avgContext: ctxSeries.length
        ? ctxSeries.reduce((a, b) => a + b, 0) / ctxSeries.length : 0,
      contextSeries: downsample(ctxSeries, 64),
      lastTurn: {
        cacheRead: lastRow.cr || 0,
        cacheCreation: lastRow.cc || 0,
        input: lastRow.inp || 0,
        output: lastRow.outp || 0,
      },
    };
  }
  const optimization = buildOptimization({ live, cacheHitRate, cacheSavings, sessionsArr });

  const insights = buildInsights({
    byDayArr,
    byToolArr,
    sessionsArr,
    byHour,
    byModelArr,
    totals,
    activeDays,
    cacheHitRate,
    cacheSavings,
  });

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      dbPath: DB_PATH,
      dbSizeBytes: fs.statSync(DB_PATH).size,
      projects: allProjects,
      firstEver: span.a,
      lastEver: span.b,
      appliedProject: project,
      appliedRange: range,
      appliedSince: since,
      appliedUntil: until,
    },
    range: {
      first: rows.length ? rows[0].ts : null,
      last: rows.length ? rows[rows.length - 1].ts : null,
      activeDays: activeDays.size,
      spanDays: byDayArr.length,
    },
    totals,
    cache: {
      read: totals.cacheRead,
      creation: totals.cacheCreation,
      input: totals.input,
      hitRate: cacheHitRate,
      savings: cacheSavings,
    },
    byModel: byModelArr,
    byProject: byProjectArr,
    byDay: byDayArr,
    byTool: byToolArr,
    byHour,
    byWeekday,
    sessions: sessionsArr,
    recent,
    insights,
    live,
    optimization,
    forecast,
    byMcpServer,
    mcpToolCalls,
    nativeToolCalls,
    projectAdvice,
  };
}

function downsample(arr, n) {
  if (arr.length <= n) return arr.slice();
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(arr[Math.floor((i * (arr.length - 1)) / (n - 1))]);
  }
  return out;
}

function classifyHealth({ fill, ageMin, turns, ctx }) {
  // ranked most-severe first; first match wins
  if (!Number.isFinite(ageMin)) ageMin = 0;
  if (!Number.isFinite(fill)) fill = 0;
  if (ageMin >= 10080) return { health:'abandoned', tone:'dim',
    message:'Dormant 7+ days — likely safe to ignore' };
  if (ageMin >= 1440) return { health:'stale', tone:'dim',
    message:'Idle 1+ day — context may be outdated' };
  // near-max wins over the tiny-context override — a single huge prompt is
  // still near-max, not "fresh".
  if (fill >= 0.75) return { health:'near-max', tone:'risk',
    message:'Run /compact now or start a fresh session' };
  if (fill >= 0.50) return { health:'getting-full', tone:'warn',
    message:'Consider /compact before deep work' };
  // tiny-context override (low fill AND barely-used) → fresh
  if (turns <= 1 || ctx < 5000) return { health:'fresh', tone:'ok',
    message:'Fresh — plenty of room to work' };
  if (fill < 0.15 && ageMin < 60 && turns <= 3) return { health:'fresh', tone:'ok',
    message:'Fresh — plenty of room to work' };
  if (fill < 0.50 && ageMin < 240) return { health:'healthy', tone:'good',
    message:'Good to continue — lots of headroom' };
  return { health:'healthy', tone:'good',
    message:'Has headroom — continue or start fresh' };
}

function buildOptimization(ctx) {
  const { live, cacheHitRate, cacheSavings, sessionsArr } = ctx;
  const tips = [];
  if (live) {
    const fill = live.currentContext / live.contextWindow;
    const pct = Math.round(fill * 100);
    if (fill >= 0.7) {
      tips.push({
        kind: 'warn',
        title: `Context window is ${pct}% full`,
        body: `Run /compact to summarize the conversation into a compact form, or /clear before an unrelated task. Both trim stale history while keeping the active task — quality stays, token weight drops.`,
      });
    } else if (fill >= 0.4) {
      tips.push({
        kind: 'tip',
        title: `Context is ${pct}% full — still healthy`,
        body: `Plenty of headroom. /compact becomes worthwhile past ~70%, when every turn re-sends a large prompt.`,
      });
    } else {
      tips.push({
        kind: 'good',
        title: `Context only ${pct}% full`,
        body: `Lots of room in the window — no need to compact or clear yet.`,
      });
    }
  }
  if (cacheHitRate >= 0.8) {
    tips.push({
      kind: 'good',
      title: `Prompt cache hit rate is ${(cacheHitRate * 100).toFixed(0)}%`,
      body: `Caching is doing its job and has saved an estimated $${Math.round(
        cacheSavings
      ).toLocaleString()}. It applies automatically — re-reads cost ~10% of fresh tokens.`,
    });
  } else {
    tips.push({
      kind: 'warn',
      title: `Cache hit rate is ${(cacheHitRate * 100).toFixed(0)}%`,
      body: `Editing a file invalidates everything cached after it. Batching related edits, and avoiding frequent /clear, keeps more of the prompt prefix cached and cheap.`,
    });
  }
  const longest = sessionsArr.reduce((a, b) => (b.turns > (a ? a.turns : -1) ? b : a), null);
  if (longest && longest.turns >= 1200) {
    tips.push({
      kind: 'tip',
      title: `Longest session ran ${longest.turns.toLocaleString()} turns`,
      body: `Long sessions carry a big context on every single turn. Splitting unrelated work into separate sessions keeps each context small — same answers, far fewer tokens.`,
    });
  }
  tips.push({
    kind: 'tip',
    title: 'Point Claude at exact files and lines',
    body: `Asking to fix "src/auth.js:42" instead of "find the auth bug" skips the search-and-read turns entirely — identical result, a fraction of the tokens.`,
  });
  tips.push({
    kind: 'tip',
    title: 'Keep CLAUDE.md lean',
    body: `CLAUDE.md is injected into every request. Trim it to durable facts so it is not paying token rent on every turn.`,
  });
  tips.push({
    kind: 'tip',
    title: 'Use /clear between unrelated tasks',
    body: `A fresh context for a new task avoids dragging the previous task's tokens along — no quality cost when the work is unrelated anyway.`,
  });
  return tips;
}

function fillDays(map) {
  const keys = [...map.keys()].sort();
  if (!keys.length) return [];
  const out = [];
  const cur = new Date(keys[0] + 'T12:00:00');
  const end = new Date(keys[keys.length - 1] + 'T12:00:00');
  while (cur <= end) {
    const k = localDate(cur);
    const a = map.get(k) || emptyAgg();
    out.push({ day: k, ...a, totalTokens: totalTokens(a) });
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}

function buildInsights(ctx) {
  const out = [];
  if (ctx.byDayArr.length) {
    const top = ctx.byDayArr.reduce((a, b) => (b.turns > a.turns ? b : a));
    out.push({
      label: 'Most active day',
      value: shortDay(top.day),
      sub: `${top.turns.toLocaleString()} turns`,
    });
  }
  if (ctx.byToolArr.length) {
    out.push({
      label: 'Favorite tool',
      value: ctx.byToolArr[0].tool,
      sub: `${ctx.byToolArr[0].count.toLocaleString()} calls`,
    });
  }
  if (ctx.sessionsArr.length) {
    const big = ctx.sessionsArr.reduce((a, b) => (b.turns > a.turns ? b : a));
    out.push({
      label: 'Longest session',
      value: `${big.turns.toLocaleString()} turns`,
      sub: big.project,
    });
  }
  let ph = 0;
  for (let i = 1; i < 24; i++) if (ctx.byHour[i] > ctx.byHour[ph]) ph = i;
  if (ctx.byHour[ph] > 0) {
    out.push({
      label: 'Peak hour',
      value: hourLabel(ph),
      sub: `${ctx.byHour[ph].toLocaleString()} turns`,
    });
  }
  if (ctx.byModelArr.length) {
    let topM = ctx.byModelArr[0];
    for (const m of ctx.byModelArr) if (m.turns > topM.turns) topM = m;
    out.push({
      label: 'Most used model',
      value: topM.display,
      sub: `${Math.round(topM.share * 100)}% of turns`,
    });
  }
  out.push({
    label: 'Cache hit rate',
    value: `${(ctx.cacheHitRate * 100).toFixed(1)}%`,
    sub: `~$${Math.round(ctx.cacheSavings).toLocaleString()} saved`,
  });
  const days = ctx.activeDays.size || 1;
  out.push({
    label: 'Daily average',
    value: `${Math.round(ctx.totals.turns / days).toLocaleString()} turns`,
    sub: `over ${ctx.activeDays.size} active day${ctx.activeDays.size === 1 ? '' : 's'}`,
  });
  return out;
}

// ---- session deep-dive ----
function buildSessionDetail(id) {
  if (!fs.existsSync(DB_PATH)) {
    const e = new Error(`Claude usage database not found at ${DB_PATH}`);
    e.code = 'NO_DB';
    throw e;
  }
  const db = new DatabaseSync(DB_PATH, { readOnly: true });
  try {
    const session = db
      .prepare('SELECT * FROM sessions WHERE session_id = ?')
      .get(id);
    if (!session) return null;
    const turns = db
      .prepare(
        `SELECT timestamp ts, model, input_tokens inp, output_tokens outp,
                cache_read_tokens cr, cache_creation_tokens cc, tool_name tool
           FROM turns WHERE session_id = ? ORDER BY timestamp ASC`
      )
      .all(id);

    const turnsOut = turns.map((t, i) => {
      const tok = {
        input: t.inp || 0,
        output: t.outp || 0,
        cacheRead: t.cr || 0,
        cacheCreation: t.cc || 0,
      };
      return {
        idx: i,
        ts: t.ts,
        model: t.model || 'unknown',
        modelDisplay: prettyModel(t.model || 'unknown'),
        tool: t.tool || '',
        ...tok,
        contextSize: tok.input + tok.cacheRead + tok.cacheCreation,
        cost: costOf(t.model, tok),
      };
    });

    const byToolMap = new Map();
    let toolCalls = 0;
    for (const t of turns)
      if (t.tool) {
        byToolMap.set(t.tool, (byToolMap.get(t.tool) || 0) + 1);
        toolCalls++;
      }
    const byTool = [...byToolMap]
      .map(([tool, count]) => ({ tool, count }))
      .sort((a, b) => b.count - a.count);

    const modelMap = new Map();
    for (const t of turns) {
      const m = t.model || 'unknown';
      modelMap.set(m, (modelMap.get(m) || 0) + 1);
    }
    const models = [...modelMap]
      .map(([m, n]) => ({ model: m, display: prettyModel(m), turns: n }))
      .sort((a, b) => b.turns - a.turns);

    const totals = {
      turns: turns.length,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
      cost: 0,
      toolCalls,
    };
    let peakContext = 0;
    for (const t of turnsOut) {
      totals.input += t.input;
      totals.output += t.output;
      totals.cacheRead += t.cacheRead;
      totals.cacheCreation += t.cacheCreation;
      totals.cost += t.cost;
      if (t.contextSize > peakContext) peakContext = t.contextSize;
    }
    const avgContext = turnsOut.length
      ? turnsOut.reduce((a, t) => a + t.contextSize, 0) / turnsOut.length
      : 0;

    // downsampled timeline for charting (keep up to 200 points)
    const slim = turnsOut.map((t) => ({
      idx: t.idx,
      ts: t.ts,
      ctx: t.contextSize,
      cost: t.cost,
      tool: t.tool,
    }));
    const timeline = downsample(slim, 200);

    // first / last turn highlights
    const last = turnsOut[turnsOut.length - 1] || null;

    return {
      session: {
        id: session.session_id,
        project: session.project_name,
        branch: session.git_branch,
        first: session.first_timestamp,
        last: session.last_timestamp,
        durationMin: Math.max(
          0,
          ((new Date(session.last_timestamp) - new Date(session.first_timestamp)) /
            60000) ||
            0
        ),
      },
      totals: { ...totals, peakContext, avgContext },
      models,
      byTool,
      timeline,
      turnCount: turns.length,
      lastTurn: last,
    };
  } finally {
    try {
      db.close();
    } catch (_) {
      /* ignore */
    }
  }
}

// ============================ TRUE LIVE (JSONL tail) ============================
// Claude Code writes per-turn events to JSONL files in ~/.claude/projects/*
// as soon as each turn completes. The usage.db cache is rebuilt on a much
// slower schedule (often only when Claude Code starts/quits). For genuine
// real-time activity ("LIVE"), we read the most-recently-modified JSONL
// directly and parse its tail.

const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

function deriveProject(cwd) {
  if (!cwd) return '(unknown)';
  // JSONL transcripts may have either POSIX (`/Users/foo/code/proj`) or
  // Windows (`C:\Users\foo\code\proj`) paths depending on the OS that
  // recorded them. Split on either separator so the project label
  // (last two segments, joined with `/`) works for both.
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  if (parts.length < 2) return parts[0] || '(unknown)';
  return parts.slice(-2).join('/');
}

function tailRead(filePath, maxBytes) {
  const fd = fs.openSync(filePath, 'r');
  try {
    const st = fs.fstatSync(fd);
    const start = Math.max(0, st.size - maxBytes);
    const len = st.size - start;
    if (len <= 0) return '';
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    let text = buf.toString('utf8');
    // first line is probably partial when we seek mid-file — discard it
    if (start > 0) {
      const i = text.indexOf('\n');
      if (i >= 0) text = text.slice(i + 1);
    }
    return text;
  } finally {
    try { fs.closeSync(fd); } catch (_) {}
  }
}

function parseLastTurns(filePath, count) {
  let text;
  try {
    text = tailRead(filePath, 500_000);
  } catch (_) {
    return [];
  }
  const lines = text.split('\n');
  const out = [];
  for (let i = lines.length - 1; i >= 0 && out.length < count; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    let j;
    try { j = JSON.parse(line); } catch (_) { continue; }
    if (j.type !== 'assistant' || !j.message || !j.message.usage) continue;
    let tool = '';
    if (Array.isArray(j.message.content)) {
      const tu = j.message.content.find((x) => x && x.type === 'tool_use');
      if (tu && tu.name) tool = tu.name;
    }
    const u = j.message.usage;
    const model = j.message.model || 'unknown';
    const tok = {
      input: u.input_tokens || 0,
      output: u.output_tokens || 0,
      cacheRead: u.cache_read_input_tokens || 0,
      cacheCreation: u.cache_creation_input_tokens || 0,
    };
    out.unshift({
      ts: j.timestamp,
      sessionId: j.sessionId,
      project: deriveProject(j.cwd),
      cwd: j.cwd || '',
      branch: j.gitBranch || '',
      model,
      modelDisplay: prettyModel(model),
      tool,
      ...tok,
      totalTokens: tok.input + tok.output + tok.cacheRead + tok.cacheCreation,
      cost: costOf(model, tok),
      stopReason: j.message.stop_reason || '',
    });
  }
  return out;
}

function findJsonlFiles() {
  if (!fs.existsSync(PROJECTS_DIR)) return [];
  const out = [];
  (function walk(dir, depth) {
    if (depth > 5) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      try {
        if (e.isDirectory()) walk(p, depth + 1);
        else if (e.isFile() && p.endsWith('.jsonl')) {
          const st = fs.statSync(p);
          // Subagent transcripts live under .../projects/<proj>/subagents/...
          // Use platform-aware separators so Windows paths classify correctly.
          const sep = path.sep;
          const subagentMarker = `${sep}subagents${sep}`;
          out.push({
            path: p,
            mtime: st.mtimeMs,
            kind: p.includes(subagentMarker) ? 'subagent' : 'main',
          });
        }
      } catch (_) {}
    }
  })(PROJECTS_DIR, 0);
  return out;
}

function readLiveFromJSONL() {
  const files = findJsonlFiles();
  if (!files.length) return null;
  files.sort((a, b) => b.mtime - a.mtime);
  const nowT = Date.now();
  const ACTIVE_WINDOW_MS = 30 * 60 * 1000;       // main sessions: any file touched in 30m
  const SUBAGENT_WINDOW_MS = 5 * 60 * 1000;      // subagents: only if updated in last 5m (still running)
  const MAX_SESSIONS = 6;

  // Filter: main sessions in the 30m window; subagents only if very recent
  // (subagent files become noise once the agent completes).
  let active = files.filter((f) => {
    const age = nowT - f.mtime;
    if (f.kind === 'subagent') return age < SUBAGENT_WINDOW_MS;
    return age < ACTIVE_WINDOW_MS;
  });
  if (active.length === 0) active = [files[0]]; // fall back to most-recent so the UI has something
  active = active.slice(0, MAX_SESSIONS);

  const sessions = [];
  const win5ms = 5 * 60 * 1000;
  const sum = (arr, fn) => arr.reduce((a, x) => a + (fn(x) || 0), 0);

  for (const f of active) {
    const turns = parseLastTurns(f.path, 30);
    if (!turns.length) continue;
    const newest = turns[turns.length - 1];
    const w5 = turns.filter((t) => nowT - new Date(t.ts).getTime() <= win5ms);
    sessions.push({
      sessionId: newest.sessionId,
      cwd: newest.cwd,
      project: newest.project,
      branch: newest.branch,
      model: newest.model,
      modelDisplay: newest.modelDisplay,
      last: newest.ts,
      kind: f.kind,            // 'main' or 'subagent'
      filePath: f.path,
      fileMtime: new Date(f.mtime).toISOString(),
      ageMs: nowT - new Date(newest.ts).getTime(),
      turnCount: turns.length,
      turns: turns.slice().reverse(),   // newest first
      last5: {
        turns: w5.length,
        tools: new Set(w5.map((t) => t.tool).filter(Boolean)).size,
        tokens: sum(w5, (t) => t.totalTokens),
        cost: sum(w5, (t) => t.cost),
      },
    });
  }
  if (!sessions.length) return null;

  return {
    asOf: new Date().toISOString(),
    count: sessions.length,
    sessions,
    activeFiles: files
      .filter((f) => nowT - f.mtime < 120000)
      .slice(0, 10)
      .map((f) => ({
        path: f.path,
        mtime: new Date(f.mtime).toISOString(),
        kind: f.kind,
        ageMs: nowT - f.mtime,
      })),
  };
}

module.exports = {
  buildStats,
  buildSessionDetail,
  readLiveFromJSONL,
  priceFor,
  costOf,
  prettyModel,
  PRICING,
  DB_PATH,
  RANGES,
};
