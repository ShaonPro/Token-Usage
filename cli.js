#!/usr/bin/env node
'use strict';

/* ============================================================================
 * Claude Usage Dashboard · cli.js — terminal report
 * ----------------------------------------------------------------------------
 * ✦  Customized by ShaonPro · https://github.com/ShaonPro
 * ==========================================================================*/

/**
 * Terminal dashboard for Claude Code usage.
 *   node cli.js [--range 7d|14d|30d|90d|all] [--project NAME] [--json]
 */

const { buildStats } = require('./stats');

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf('--' + name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
if (args.includes('--help') || args.includes('-h')) {
  console.log(`
  Claude Usage — terminal dashboard

  Usage:
    node cli.js [options]

  Options:
    --range  <7d|14d|30d|90d|all>   time window (default: all)
    --project <name>                filter to one project
    --json                          print raw JSON
    --help                          show this help
`);
  process.exit(0);
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  coral: '\x1b[38;5;209m',
  coral2: '\x1b[38;5;173m',
  text: '\x1b[38;5;252m',
  mute: '\x1b[38;5;245m',
  faint: '\x1b[38;5;240m',
  green: '\x1b[38;5;114m',
  violet: '\x1b[38;5;141m',
  blue: '\x1b[38;5;75m',
  amber: '\x1b[38;5;179m',
  teal: '\x1b[38;5;79m',
  pink: '\x1b[38;5;211m',
};
const SERIES = [C.coral, C.violet, C.teal, C.amber, C.blue, C.pink, C.green];
const SPARKS = '▁▂▃▄▅▆▇█';
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

function fmtInt(n) {
  return Math.round(n).toLocaleString('en-US');
}
function fmtNum(n) {
  const a = Math.abs(n);
  if (a >= 1e9) return (n / 1e9).toFixed(2) + ' B';
  if (a >= 1e6) return (n / 1e6).toFixed(2) + ' M';
  if (a >= 1e3) return (n / 1e3).toFixed(1) + ' K';
  return String(Math.round(n));
}
function fmtCost(n) {
  if (n >= 1000) return '$' + fmtInt(n);
  if (n >= 1) return '$' + n.toFixed(2);
  if (n > 0) return '$' + n.toFixed(4);
  return '$0';
}
function bar(val, max, width, color) {
  const frac = max > 0 ? Math.min(1, val / max) : 0;
  const full = frac * width;
  let whole = Math.floor(full);
  let rem = Math.round((full - whole) * 8);
  if (rem === 8) {
    whole++;
    rem = 0;
  }
  const s = '█'.repeat(whole) + (rem > 0 ? EIGHTHS[rem] : '');
  return color + s.padEnd(width, ' ') + C.reset;
}
function spark(vals) {
  const max = Math.max(...vals, 1);
  return vals
    .map((v) => SPARKS[Math.min(7, Math.floor((v / max) * 7.999))])
    .join('');
}
function rule(w) {
  return C.faint + '─'.repeat(w) + C.reset;
}
function head(s) {
  return '\n  ' + C.coral + C.bold + s.toUpperCase() + C.reset + '\n';
}
function pad(s, n) {
  s = String(s);
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}
function padL(s, n) {
  s = String(s);
  return s.length >= n ? s : ' '.repeat(n - s.length) + s;
}

let data;
try {
  data = buildStats({ range: arg('range', 'all'), project: arg('project', 'all') });
} catch (e) {
  console.error(`\n  ${C.coral}Error:${C.reset} ${e.message}\n`);
  process.exit(1);
}

if (args.includes('--json')) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

const W = Math.min(Math.max(process.stdout.columns || 80, 64), 96) - 4;
const t = data.totals;
const rangeLabel =
  data.meta.appliedRange === 'all' ? 'all time' : 'last ' + data.meta.appliedRange;
const projLabel =
  data.meta.appliedProject === 'all'
    ? 'all projects'
    : data.meta.appliedProject;

// ---- header ---------------------------------------------------------------
console.log('');
console.log(
  `  ${C.coral}${C.bold}✦  CLAUDE USAGE${C.reset}  ${C.faint}·${C.reset}  ${C.mute}${rangeLabel}${C.reset}  ${C.faint}·${C.reset}  ${C.mute}${projLabel}${C.reset}`
);
if (data.range.first) {
  console.log(
    `  ${C.faint}${new Date(data.range.first).toLocaleDateString()} → ${new Date(
      data.range.last
    ).toLocaleDateString()}${C.reset}`
  );
}
console.log('  ' + rule(W));

// ---- KPI grid -------------------------------------------------------------
function kpi(label, value, color) {
  return (
    C.mute +
    pad(label, 20) +
    C.reset +
    (color || C.text) +
    C.bold +
    pad(value, 22) +
    C.reset
  );
}
console.log('');
console.log(
  '  ' +
    kpi('Tokens processed', fmtNum(t.totalTokens), C.coral) +
    kpi('Est. API cost', fmtCost(t.cost), C.green)
);
console.log(
  '  ' +
    kpi('Sessions', fmtInt(t.sessions), C.text) +
    kpi('Turns', fmtInt(t.turns), C.text)
);
console.log(
  '  ' +
    kpi('Tool calls', fmtInt(t.toolCalls), C.text) +
    kpi('Active days', fmtInt(data.range.activeDays), C.text)
);
console.log(
  '  ' +
    kpi('Cache hit rate', (data.cache.hitRate * 100).toFixed(1) + '%', C.violet) +
    kpi('Cache savings', '~' + fmtCost(data.cache.savings), C.green)
);
console.log(
  '  ' +
    kpi('Output tokens', fmtNum(t.output), C.text) +
    kpi(
      'Avg / session',
      fmtInt(t.sessions ? t.turns / t.sessions : 0) + ' turns',
      C.text
    )
);

// ---- models ---------------------------------------------------------------
if (data.byModel.length) {
  console.log(head('Models'));
  const maxTurns = Math.max(...data.byModel.map((m) => m.turns), 1);
  const sorted = [...data.byModel].sort((a, b) => b.turns - a.turns);
  sorted.forEach((m, i) => {
    const col = SERIES[i % SERIES.length];
    console.log(
      '  ' +
        col +
        pad(m.display, 14) +
        C.reset +
        bar(m.turns, maxTurns, 22, col) +
        ' ' +
        C.text +
        padL(fmtInt(m.turns), 8) +
        C.reset +
        C.faint +
        padL(Math.round(m.share * 100) + '%', 6) +
        C.reset +
        C.green +
        padL(fmtCost(m.cost), 12) +
        C.reset
    );
  });
}

// ---- projects -------------------------------------------------------------
if (data.byProject.length) {
  console.log(head('Projects'));
  const maxCost = Math.max(...data.byProject.map((p) => p.cost), 0.000001);
  data.byProject.forEach((p, i) => {
    const col = SERIES[i % SERIES.length];
    const name =
      p.project.length > 22 ? '…' + p.project.slice(-21) : p.project;
    console.log(
      '  ' +
        col +
        pad(name, 23) +
        C.reset +
        bar(p.cost, maxCost, 20, col) +
        ' ' +
        C.green +
        padL(fmtCost(p.cost), 11) +
        C.reset +
        C.faint +
        padL(p.sessions + ' sess', 10) +
        ' ' +
        padL(fmtInt(p.turns) + ' turns', 13) +
        C.reset
    );
  });
}

// ---- tools ----------------------------------------------------------------
if (data.byTool.length) {
  console.log(head('Top tools'));
  const tools = data.byTool.slice(0, 12);
  const maxC = Math.max(...tools.map((x) => x.count), 1);
  tools.forEach((x) => {
    const name = x.tool.length > 26 ? x.tool.slice(0, 25) + '…' : x.tool;
    console.log(
      '  ' +
        C.text +
        pad(name, 27) +
        C.reset +
        bar(x.count, maxC, 24, C.coral2) +
        ' ' +
        C.mute +
        padL(fmtInt(x.count), 8) +
        C.reset
    );
  });
}

// ---- daily activity -------------------------------------------------------
if (data.byDay.length > 1) {
  console.log(head('Daily activity'));
  const turns = data.byDay.map((d) => d.turns);
  console.log('  ' + C.coral + spark(turns) + C.reset);
  console.log(
    '  ' +
      C.faint +
      pad(new Date(data.byDay[0].day + 'T12:00:00').toLocaleDateString(), 14) +
      C.reset +
      ' '.repeat(Math.max(0, turns.length - 28)) +
      C.faint +
      new Date(
        data.byDay[data.byDay.length - 1].day + 'T12:00:00'
      ).toLocaleDateString() +
      C.reset
  );
}

// ---- insights -------------------------------------------------------------
if (data.insights.length) {
  console.log(head('Insights'));
  data.insights.forEach((ins) => {
    console.log(
      '  ' +
        C.coral +
        '▸ ' +
        C.reset +
        C.mute +
        pad(ins.label, 20) +
        C.reset +
        C.text +
        C.bold +
        pad(ins.value, 18) +
        C.reset +
        C.faint +
        ins.sub +
        C.reset
    );
  });
}

// ---- footer ---------------------------------------------------------------
console.log('');
console.log('  ' + rule(W));
console.log(
  '  ' +
    C.faint +
    `${data.meta.dbPath}  ·  generated ${new Date(
      data.meta.generatedAt
    ).toLocaleString()}` +
    C.reset
);
console.log(
  '  ' +
    C.faint +
    'Costs are estimated Anthropic API list prices — not subscription billing.' +
    C.reset
);
console.log('');
