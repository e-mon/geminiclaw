/**
 * dashboard/page.ts — Self-contained HTML dashboard page with Chart.js (CDN).
 *
 * Datadog-inspired dark analytics dashboard. Served as a single HTML
 * response — no static file hosting needed.
 * Fetches data from /api/dashboard/* endpoints on page load.
 *
 * Layout zones:
 *   1. KPI bar (6 cards) — includes MCP server count
 *   2. Timeline + Distributions (charts)
 *   3. Tooling — Skills + MCP Servers side-by-side, unified tool table
 *   4. Errors & Retries — Error chart + Retry table side-by-side, Error patterns full-width
 */

export function renderDashboardHTML(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeminiClaw Dashboard</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script src="https://cdn.jsdelivr.net/npm/hammerjs@2"></script>
<script src="https://cdn.jsdelivr.net/npm/chartjs-plugin-zoom@2"></script>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/themes/dark.css">
<script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
<style>
  :root {
    --bg: #0d0f14; --bg-raised: #131620; --card: #181c28;
    --border: #232838; --border-hover: #343b50;
    --text: #e8e8ed; --text-secondary: #9ca3b4; --muted: #636b7e;
    --accent: #7b68ee; --accent-dim: #7b68ee30;
    --red: #f06060; --red-dim: #f0606025;
    --green: #3dd68c; --green-dim: #3dd68c25;
    --yellow: #f0c040; --yellow-dim: #f0c04025;
    --orange: #f09040; --blue: #5b9ef0; --purple: #a07ef0;
    --cyan: #40d0d0;
    --font-mono: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif; background: var(--bg); color: var(--text); min-height: 100vh; }

  /* ── Top Nav ────────────────────────────────────── */
  .topnav { display: flex; align-items: center; justify-content: space-between; padding: 0 24px; height: 48px; background: var(--bg-raised); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 50; }
  .topnav-left { display: flex; align-items: center; gap: 16px; }
  .topnav-logo { font-weight: 700; font-size: 0.9rem; letter-spacing: -0.02em; }
  .topnav-logo span { color: var(--accent); }
  .topnav-tabs { display: flex; gap: 2px; }
  .topnav-tabs a { color: var(--muted); text-decoration: none; font-size: 0.78rem; padding: 6px 12px; border-radius: 6px; transition: all .12s; }
  .topnav-tabs a:hover { color: var(--text); background: var(--border); }
  .topnav-tabs a.active { color: var(--text); background: var(--accent-dim); }
  .topnav-right { display: flex; align-items: center; gap: 12px; }

  /* ── Pool Flyout ────────────────────────────────── */
  .pool-btn { display: flex; align-items: center; gap: 6px; font-size: 0.72rem; color: var(--muted); padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; cursor: pointer; background: none; position: relative; transition: all .12s; }
  .pool-btn:hover { border-color: var(--border-hover); color: var(--text); }
  .pool-btn .pool-count { font-family: var(--font-mono); font-weight: 600; color: var(--text); }
  .pool-dots-inline { display: flex; gap: 3px; }
  .pool-dot-sm { width: 7px; height: 7px; border-radius: 50%; }
  .pool-dot-sm.idle { background: var(--green); }
  .pool-dot-sm.in-use { background: var(--orange); }
  .pool-dot-sm.closed { background: var(--red); }
  .pool-flyout { display: none; position: absolute; top: 100%; right: 0; margin-top: 8px; background: var(--card); border: 1px solid var(--border); border-radius: 10px; width: 360px; z-index: 100; box-shadow: 0 12px 48px #000a; overflow: hidden; }
  .pool-flyout.open { display: block; }
  .pool-flyout-head { display: flex; align-items: center; justify-content: space-between; padding: 12px 16px; border-bottom: 1px solid var(--border); }
  .pool-flyout-head .pf-title { font-size: 0.78rem; font-weight: 600; }
  .pool-flyout-head .pf-link { font-size: 0.68rem; color: var(--accent); text-decoration: none; }
  .pool-flyout-head .pf-link:hover { text-decoration: underline; }
  .pool-flyout-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1px; background: var(--border); }
  .pool-flyout-stat { background: var(--card); padding: 10px 0; text-align: center; }
  .pool-flyout-stat .pfs-val { font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .pool-flyout-stat .pfs-lbl { font-size: 0.6rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 2px; }
  .pool-flyout-bar { padding: 12px 16px; border-top: 1px solid var(--border); }
  .pool-bar-track { height: 8px; background: var(--bg); border-radius: 4px; overflow: hidden; display: flex; }
  .pool-bar-seg { height: 100%; transition: width .3s; }
  .pool-bar-seg.in-use { background: var(--orange); }
  .pool-bar-seg.idle { background: var(--green); }
  .pool-bar-seg.empty { background: transparent; }
  .pool-bar-legend { display: flex; gap: 12px; margin-top: 6px; font-size: 0.65rem; color: var(--muted); }
  .pool-bar-legend span::before { content: ''; display: inline-block; width: 6px; height: 6px; border-radius: 50%; margin-right: 4px; vertical-align: middle; }
  .pool-bar-legend .leg-inuse::before { background: var(--orange); }
  .pool-bar-legend .leg-idle::before { background: var(--green); }
  .pool-bar-legend .leg-free::before { background: var(--border); }
  .pool-flyout-procs { max-height: 200px; overflow-y: auto; }
  .pool-proc { display: flex; align-items: center; gap: 10px; padding: 8px 16px; border-top: 1px solid var(--border); font-size: 0.72rem; }
  .pool-proc-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .pool-proc-dot.idle { background: var(--green); }
  .pool-proc-dot.in-use { background: var(--orange); }
  .pool-proc-dot.closed { background: var(--red); }
  .pool-proc-info { flex: 1; min-width: 0; }
  .pool-proc-key { font-family: var(--font-mono); font-size: 0.68rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .pool-proc-meta { font-size: 0.65rem; color: var(--muted); margin-top: 1px; }
  .pool-proc-badge { font-size: 0.62rem; padding: 1px 6px; border-radius: 3px; font-weight: 600; }
  .pool-proc-badge.idle { background: var(--green-dim); color: var(--green); }
  .pool-proc-badge.in-use { background: #f0904025; color: var(--orange); }
  .pool-proc-badge.closed { background: var(--red-dim); color: var(--red); }
  .pool-empty-msg { padding: 20px 16px; text-align: center; color: var(--muted); font-size: 0.75rem; font-style: italic; }

  /* ── Time Picker ─────────────────────────────────── */
  .time-bar { display: flex; align-items: center; gap: 8px; padding: 10px 24px; background: var(--bg-raised); border-bottom: 1px solid var(--border); }
  .time-bar .label { color: var(--muted); font-size: 0.72rem; margin-right: 2px; }
  .time-pills { display: flex; gap: 2px; background: var(--bg); border-radius: 6px; padding: 2px; border: 1px solid var(--border); }
  .time-pills button { padding: 4px 12px; border: none; border-radius: 4px; background: transparent; color: var(--muted); font-size: 0.72rem; font-weight: 500; cursor: pointer; transition: all .12s; white-space: nowrap; }
  .time-pills button:hover { color: var(--text); }
  .time-pills button.active { background: var(--accent); color: #fff; }
  .time-custom { display: flex; align-items: center; gap: 4px; }
  .time-custom input { width: 112px; padding: 4px 8px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 0.72rem; font-family: var(--font-mono); cursor: pointer; outline: none; text-align: center; }
  .time-custom input:focus { border-color: var(--accent); }
  .time-custom .sep { color: var(--muted); font-size: 0.72rem; }
  .time-display { margin-left: auto; font-size: 0.72rem; color: var(--muted); font-family: var(--font-mono); }
  .zoom-hint { font-size: 0.65rem; color: var(--muted); opacity: 0; transition: opacity .3s; margin-left: 8px; }
  .zoom-hint.visible { opacity: 1; }
  .loading-bar { height: 2px; background: var(--accent); position: fixed; top: 48px; left: 0; z-index: 100; transition: width .3s; }
  .flatpickr-calendar { background: var(--card) !important; border: 1px solid var(--border) !important; box-shadow: 0 8px 32px #0008 !important; font-size: 0.78rem !important; }
  .flatpickr-day.selected, .flatpickr-day.startRange, .flatpickr-day.endRange { background: var(--accent) !important; border-color: var(--accent) !important; }
  .flatpickr-day.inRange { background: var(--accent-dim) !important; box-shadow: none !important; }

  /* ── Content ────────────────────────────────────── */
  .content { padding: 20px 24px 40px; max-width: 1440px; margin: 0 auto; }

  /* ── KPI Cards ──────────────────────────────────── */
  .kpi-grid { display: grid; grid-template-columns: repeat(6, 1fr); gap: 10px; margin-bottom: 20px; }
  @media (max-width: 1100px) { .kpi-grid { grid-template-columns: repeat(3, 1fr); } }
  @media (max-width: 640px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; transition: border-color .15s; position: relative; overflow: hidden; }
  .kpi:hover { border-color: var(--border-hover); }
  .kpi .kpi-label { color: var(--muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.06em; font-weight: 500; }
  .kpi .kpi-value { font-size: 1.4rem; font-weight: 700; margin-top: 4px; font-variant-numeric: tabular-nums; }
  .kpi .kpi-sub { color: var(--text-secondary); font-size: 0.7rem; margin-top: 3px; }
  .kpi .kpi-spark { position: absolute; bottom: 0; right: 0; width: 80px; height: 32px; opacity: 0.5; }
  .kpi.green .kpi-value { color: var(--green); }
  .kpi.red .kpi-value { color: var(--red); }
  .kpi.yellow .kpi-value { color: var(--yellow); }

  /* ── Chart Panels ───────────────────────────────── */
  .panels { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-bottom: 12px; }
  .panels.trio { grid-template-columns: 1fr 1fr 1fr; }
  @media (max-width: 1100px) { .panels.trio { grid-template-columns: 1fr; } }
  @media (max-width: 900px) { .panels { grid-template-columns: 1fr; } }
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .panel.full { grid-column: 1 / -1; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .panel-title { font-size: 0.78rem; font-weight: 600; }
  .panel-badge { font-size: 0.68rem; color: var(--muted); padding: 2px 8px; background: var(--bg); border-radius: 4px; }
  .panel-body { padding: 14px; }
  .panel-body canvas { width: 100% !important; }
  .panel-body.compact { padding: 10px 14px; }

  /* ── Tables ─────────────────────────────────────── */
  table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.05em; padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  td { padding: 7px 12px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: #ffffff04; }
  .bar-cell { position: relative; }
  .bar-fill { position: absolute; left: 0; top: 3px; bottom: 3px; opacity: 0.12; border-radius: 3px; }
  .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
  .badge-green { background: var(--green-dim); color: var(--green); }
  .badge-yellow { background: var(--yellow-dim); color: var(--yellow); }
  .badge-red { background: var(--red-dim); color: var(--red); }
  .mono { font-family: var(--font-mono); font-size: 0.72rem; }
  .empty { color: var(--muted); font-style: italic; padding: 24px; text-align: center; font-size: 0.8rem; }
  .retry-streak { display: inline-block; background: var(--orange); color: #000; font-weight: 700; border-radius: 4px; padding: 1px 6px; font-size: 0.72rem; }
  .error-msg { font-family: var(--font-mono); font-size: 0.72rem; color: var(--text-secondary); word-break: break-all; max-width: 550px; }

  /* ── Section dividers ───────────────────────────── */
  .section { margin-top: 24px; }
  .section-head { display: flex; align-items: center; gap: 8px; margin-bottom: 12px; }
  .section-title { font-size: 0.85rem; font-weight: 600; }
  .section-desc { font-size: 0.72rem; color: var(--muted); }
  .section-divider { flex: 1; height: 1px; background: var(--border); }

  /* ── MCP Server Cards ──────────────────────────── */
  .mcp-grid { display: flex; flex-direction: column; gap: 4px; }
  .mcp-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; background: var(--bg); border-radius: 6px; font-size: 0.75rem; cursor: pointer; transition: background 0.15s; }
  .mcp-row:hover { background: var(--card); }
  .mcp-chevron { color: var(--muted); font-size: 0.6rem; transition: transform 0.15s; flex-shrink: 0; }
  .mcp-chevron.open { transform: rotate(90deg); }
  .mcp-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .mcp-dot.active { background: var(--green); box-shadow: 0 0 4px var(--green); }
  .mcp-dot.healthy { background: var(--green); opacity: 0.7; }
  .mcp-dot.error { background: var(--red); box-shadow: 0 0 4px var(--red); }
  .mcp-name { font-weight: 600; flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .mcp-stats { display: flex; gap: 10px; font-size: 0.68rem; color: var(--muted); font-family: var(--font-mono); }
  .mcp-badge { font-size: 0.58rem; padding: 1px 6px; border-radius: 8px; font-weight: 600; }
  .mcp-badge.built-in { background: var(--accent-dim); color: var(--accent); }
  .mcp-badge.external { background: var(--green-dim); color: var(--green); }
  .mcp-tools { display: none; padding: 2px 12px 8px 28px; }
  .mcp-tools.open { display: block; }
  .mcp-tool-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; font-size: 0.68rem; font-family: var(--font-mono); color: var(--text-secondary); border-bottom: 1px solid var(--border); }
  .mcp-tool-row:last-child { border-bottom: none; }
  .mcp-tool-name { flex: 1; }
  .mcp-tool-calls { color: var(--muted); }
  .mcp-tool-err { color: var(--red); }
  .mcp-tool-desc { color: var(--muted); cursor: help; font-style: normal; font-size: 0.6rem; }
  .mcp-no-tools { color: var(--muted); font-size: 0.68rem; font-style: italic; padding: 4px 0; }
  .mcp-empty { color: var(--muted); font-size: 0.75rem; font-style: italic; padding: 12px; text-align: center; }
</style>
</head>
<body>

<!-- ── Top Navigation ─────────────────────────────── -->
<div class="topnav">
  <div class="topnav-left">
    <div class="topnav-logo"><span>Gemini</span>Claw</div>
    <div class="topnav-tabs">
      <a href="/dashboard" class="active">Overview</a>
      <a href="/dashboard/runs">Runs</a>
    </div>
  </div>
  <div class="topnav-right">
    <button class="pool-btn" id="pool-btn">
      <span>Pool</span>
      <span class="pool-count" id="pool-count">0</span>
      <div class="pool-dots-inline" id="pool-dots-inline"></div>
      <div class="pool-flyout" id="pool-flyout">
        <div class="pool-flyout-head">
          <span class="pf-title">Process Pool</span>
          <a href="/dashboard/pool" class="pf-link">Full view &rarr;</a>
        </div>
        <div class="pool-flyout-stats" id="pool-flyout-stats"></div>
        <div class="pool-flyout-bar" id="pool-flyout-bar"></div>
        <div class="pool-flyout-procs" id="pool-flyout-procs"></div>
      </div>
    </button>
  </div>
</div>

<!-- ── Time Range Bar ─────────────────────────────── -->
<div class="time-bar">
  <span class="label">Period</span>
  <div class="time-pills" id="time-pills">
    <button data-range="1d">1D</button>
    <button data-range="3d">3D</button>
    <button data-range="7d" class="active">7D</button>
    <button data-range="14d">14D</button>
    <button data-range="30d">30D</button>
    <button data-range="90d">90D</button>
    <button data-range="all">All</button>
  </div>
  <div class="time-custom">
    <input type="text" id="date-from" placeholder="From">
    <span class="sep">&mdash;</span>
    <input type="text" id="date-to" placeholder="To">
  </div>
  <span class="zoom-hint" id="zoom-hint">Drag on chart to zoom &middot; dblclick to reset</span>
  <div class="time-display" id="time-display"></div>
</div>

<div class="loading-bar" id="loading-bar" style="width:0"></div>

<div class="content">
  <!-- Zone 1: KPI Cards -->
  <div class="kpi-grid" id="kpi-grid"></div>

  <!-- Zone 2: Timeline -->
  <div class="panels">
    <div class="panel full">
      <div class="panel-head">
        <span class="panel-title">Token Usage & Cost</span>
        <span class="panel-badge" id="timeline-badge"></span>
      </div>
      <div class="panel-body">
        <canvas id="timelineChart" height="160"></canvas>
      </div>
    </div>
  </div>

  <!-- Zone 2: Distributions -->
  <div class="panels trio">
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Triggers</span></div>
      <div class="panel-body compact" style="display:flex;align-items:center;justify-content:center">
        <canvas id="triggerChart" height="140"></canvas>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Models</span></div>
      <div class="panel-body compact" style="display:flex;align-items:center;justify-content:center">
        <canvas id="modelChart" height="140"></canvas>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><span class="panel-title">Cost by Model</span></div>
      <div class="panel-body compact" style="display:flex;align-items:center;justify-content:center">
        <canvas id="costModelChart" height="140"></canvas>
      </div>
    </div>
  </div>

  <!-- Zone 3: Tooling -->
  <div class="section">
    <div class="section-head">
      <span class="section-title">Tooling</span>
      <span class="section-desc">Skills, MCP servers & tool usage</span>
      <div class="section-divider"></div>
    </div>
    <!-- Skills + MCP Servers side by side -->
    <div class="panels">
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Skill Usage</span></div>
        <div class="panel-body" style="padding:0">
          <table id="skillTable">
            <thead><tr><th style="width:36px">#</th><th>Skill</th><th style="width:100px">Activations</th><th>Breakdown</th></tr></thead>
            <tbody></tbody>
          </table>
          <div class="empty" id="skillEmpty" style="display:none">No skill activations in this period</div>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head">
          <span class="panel-title">MCP Servers</span>
          <span class="panel-badge" id="mcp-badge"></span>
        </div>
        <div class="panel-body">
          <div class="mcp-grid" id="mcp-grid">
            <div class="mcp-empty">Loading...</div>
          </div>
        </div>
      </div>
    </div>
    <!-- Unified tool table -->
    <div class="panels">
      <div class="panel full">
        <div class="panel-head">
          <span class="panel-title">Tool Usage</span>
          <span class="panel-badge" id="tool-badge">Top 20</span>
        </div>
        <div class="panel-body" style="padding:0">
          <table id="toolTable">
            <thead><tr><th style="width:36px">#</th><th>Tool</th><th style="width:90px">Server</th><th style="width:80px">Calls</th><th>Breakdown</th></tr></thead>
            <tbody></tbody>
          </table>
        </div>
      </div>
    </div>
  </div>

  <!-- Zone 4: Errors & Retries -->
  <div class="section">
    <div class="section-head">
      <span class="section-title">Errors & Retries</span>
      <span class="section-desc">Error rates, patterns & retry detection</span>
      <div class="section-divider"></div>
    </div>
    <div class="panels">
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Error Rate by Tool</span></div>
        <div class="panel-body">
          <canvas id="errorRateChart" height="280"></canvas>
        </div>
      </div>
      <div class="panel">
        <div class="panel-head"><span class="panel-title">Retry Detection</span><span class="panel-badge">3+ consecutive</span></div>
        <div class="panel-body" style="padding:0">
          <table id="retryTable">
            <thead><tr><th>Tool</th><th>Occurrences</th><th>Max</th><th>Avg</th></tr></thead>
            <tbody></tbody>
          </table>
          <div class="empty" id="retryEmpty" style="display:none">No retry patterns in this period</div>
        </div>
      </div>
    </div>
    <div class="panels">
      <div class="panel full">
        <div class="panel-head"><span class="panel-title">Error Patterns</span><span class="panel-badge">Top 10</span></div>
        <div class="panel-body" style="padding:0">
          <table id="errorPatternTable">
            <thead><tr><th style="width:36px">#</th><th>Error Message</th><th style="width:70px">Count</th><th>Tools</th></tr></thead>
            <tbody></tbody>
          </table>
          <div class="empty" id="patternEmpty" style="display:none">No error patterns in this period</div>
        </div>
      </div>
    </div>
  </div>
</div>

<script>
(function() {
  const COLORS = ['#7b68ee','#f472b6','#3dd68c','#f0c040','#5b9ef0','#f09040','#a07ef0','#f06060','#40d0d0','#e879f9'];
  // builtIn flag is now returned by /api/dashboard/mcp per server
  const RANGE_DAYS = { '1d':1, '3d':3, '7d':7, '14d':14, '30d':30, '90d':90, 'all':0 };
  let currentRange = '7d';
  let customSince = null;
  let customTo = null;
  let timelineChart, triggerChart, modelChart, costModelChart, errorRateChart;

  Chart.defaults.color = '#636b7e';
  Chart.defaults.borderColor = '#232838';
  Chart.defaults.font.family = "-apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
  Chart.defaults.font.size = 11;

  // ── Helpers ──
  function sinceDate(range) {
    if (customSince) return customSince;
    const days = RANGE_DAYS[range];
    if (!days) return undefined;
    const d = new Date(); d.setDate(d.getDate() - days);
    return d.toISOString().slice(0, 10);
  }
  function sinceParam(range) { const s = sinceDate(range); return s ? '?since=' + s : ''; }
  async function fetchJSON(path) { return (await fetch(path)).json(); }
  function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : '0'; }
  function fmtK(n) { return n >= 1000 ? (n/1000).toFixed(1) + 'k' : fmt(n); }
  function fmtCost(n) { return '$' + n.toFixed(2); }
  function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }

  window.toggleMcpTools = function(idx) {
    const tools = document.getElementById('mcp-tools-' + idx);
    const chev = document.getElementById('mcp-chev-' + idx);
    if (tools && chev) {
      tools.classList.toggle('open');
      chev.classList.toggle('open');
    }
  };

  function updateTimeDisplay(range) {
    const el = document.getElementById('time-display');
    const since = sinceDate(range);
    if (!since) { el.textContent = 'All time'; return; }
    const from = new Date(since);
    const to = customTo ? new Date(customTo) : new Date();
    el.textContent = from.toLocaleDateString('en-US', { month:'short', day:'numeric' }) +
      ' — ' + to.toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' });
  }

  function kpi(label, value, sub, cls, sparkData) {
    let spark = '';
    if (sparkData && sparkData.length > 1) {
      const max = Math.max(...sparkData, 1);
      const w = 80, h = 32;
      const step = w / (sparkData.length - 1);
      const points = sparkData.map((v, i) => (i * step) + ',' + (h - (v / max) * h * 0.85));
      const color = cls === 'red' ? 'var(--red)' : cls === 'green' ? 'var(--green)' : 'var(--accent)';
      spark = '<svg class="kpi-spark" viewBox="0 0 ' + w + ' ' + h + '" preserveAspectRatio="none">' +
        '<polyline fill="none" stroke="' + color + '" stroke-width="1.5" points="' + points.join(' ') + '"/></svg>';
    }
    return '<div class="kpi' + (cls ? ' ' + cls : '') + '"><div class="kpi-label">' + label + '</div>' +
      '<div class="kpi-value">' + value + '</div>' + (sub ? '<div class="kpi-sub">' + sub + '</div>' : '') + spark + '</div>';
  }

  function rateBadge(rate) {
    if (rate >= 0.3) return '<span class="badge badge-red">' + fmtPct(rate) + '</span>';
    if (rate >= 0.1) return '<span class="badge badge-yellow">' + fmtPct(rate) + '</span>';
    return '<span class="badge badge-green">' + fmtPct(rate) + '</span>';
  }

  // ── Pool Flyout ──
  document.getElementById('pool-btn').addEventListener('click', function(ev) {
    ev.stopPropagation();
    document.getElementById('pool-flyout').classList.toggle('open');
  });
  document.addEventListener('click', function() { document.getElementById('pool-flyout').classList.remove('open'); });
  document.getElementById('pool-flyout').addEventListener('click', function(ev) { ev.stopPropagation(); });

  function timeAgo(ms) {
    if (!ms) return '—';
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
  }

  async function refreshPool() {
    try {
      const data = await fetchJSON('/api/dashboard/pool');
      const entries = data.entries;
      const total = entries.length;
      const inUse = entries.filter(e => e.inUse).length;
      const idle = entries.filter(e => !e.inUse && !e.closed).length;
      const max = data.maxSize;
      const free = max - total;

      document.getElementById('pool-count').textContent = total + '/' + max;
      document.getElementById('pool-dots-inline').innerHTML = entries.map(e =>
        '<div class="pool-dot-sm ' + (e.closed ? 'closed' : e.inUse ? 'in-use' : 'idle') + '"></div>').join('');

      document.getElementById('pool-flyout-stats').innerHTML =
        '<div class="pool-flyout-stat"><div class="pfs-val">' + max + '</div><div class="pfs-lbl">Max</div></div>' +
        '<div class="pool-flyout-stat"><div class="pfs-val" style="color:var(--orange)">' + inUse + '</div><div class="pfs-lbl">In Use</div></div>' +
        '<div class="pool-flyout-stat"><div class="pfs-val" style="color:var(--green)">' + idle + '</div><div class="pfs-lbl">Idle</div></div>' +
        '<div class="pool-flyout-stat"><div class="pfs-val' + (data.waiting > 0 ? '" style="color:var(--red)' : '') + '">' + data.waiting + '</div><div class="pfs-lbl">Waiting</div></div>';

      const barInUse = max > 0 ? (inUse / max * 100) : 0;
      const barIdle = max > 0 ? (idle / max * 100) : 0;
      document.getElementById('pool-flyout-bar').innerHTML =
        '<div class="pool-bar-track"><div class="pool-bar-seg in-use" style="width:' + barInUse + '%"></div><div class="pool-bar-seg idle" style="width:' + barIdle + '%"></div></div>' +
        '<div class="pool-bar-legend"><span class="leg-inuse">' + inUse + ' in use</span><span class="leg-idle">' + idle + ' idle</span><span class="leg-free">' + free + ' free</span></div>';

      if (total === 0) {
        document.getElementById('pool-flyout-procs').innerHTML = '<div class="pool-empty-msg">No active processes</div>';
      } else {
        document.getElementById('pool-flyout-procs').innerHTML = entries.map(e => {
          const st = e.closed ? 'closed' : e.inUse ? 'in-use' : 'idle';
          const sid = e.lastSessionId ? e.lastSessionId.substring(0, 10) : '—';
          const key = e.key.length > 35 ? '…' + e.key.slice(-35) : e.key;
          return '<div class="pool-proc"><div class="pool-proc-dot ' + st + '"></div>' +
            '<div class="pool-proc-info"><div class="pool-proc-key">' + esc(key) + '</div><div class="pool-proc-meta">session: ' + esc(sid) + ' · ' + timeAgo(e.lastUsedAt) + '</div></div>' +
            '<span class="pool-proc-badge ' + st + '">' + st.replace('-', ' ') + '</span></div>';
        }).join('');
      }
    } catch { /* ignore */ }
  }
  refreshPool();
  setInterval(refreshPool, 5000);

  // ── Main dashboard loader ──
  async function loadDashboard(range) {
    currentRange = range;
    document.querySelectorAll('#time-pills button').forEach(b => b.classList.toggle('active', b.dataset.range === range));
    updateTimeDisplay(range);

    const bar = document.getElementById('loading-bar');
    bar.style.width = '30%';

    const q = sinceParam(range);
    const [summary, timeline, tools, triggers, errors, errorPatterns, retries, efficiency, skills, mcp] = await Promise.all([
      fetchJSON('/api/dashboard/summary' + q),
      fetchJSON('/api/dashboard/timeline' + q),
      fetchJSON('/api/dashboard/tools' + q),
      fetchJSON('/api/dashboard/triggers' + q),
      fetchJSON('/api/dashboard/errors' + q),
      fetchJSON('/api/dashboard/error-patterns' + q),
      fetchJSON('/api/dashboard/retries' + q),
      fetchJSON('/api/dashboard/efficiency' + q),
      fetchJSON('/api/dashboard/skills' + q),
      fetchJSON('/api/dashboard/mcp' + q),
    ]);
    bar.style.width = '80%';

    // ── Zone 1: KPI cards ──
    const tokenSpark = timeline.map(d => d.tokens);
    const runSpark = timeline.map(d => d.runs);
    const costSpark = timeline.map(d => d.cost);
    const mcpServers = mcp.servers || [];
    const mcpProbes = mcp.probes || [];
    const mcpProbeMap = {};
    for (const p of mcpProbes) { mcpProbeMap[p.name] = p; }
    const mcpErrors = (mcp.toolStats || []).reduce((a, t) => a + t.errors, 0);
    const mcpUnhealthy = mcpProbes.filter(p => !p.healthy).length;

    document.getElementById('kpi-grid').innerHTML =
      kpi('Total Runs', fmt(summary.totalRuns), summary.totalRuns > 0 ? fmtK(efficiency.avgToolCallsPerRun.toFixed(1)) + ' tools/run avg' : '', '', runSpark) +
      kpi('Total Tokens', fmtK(summary.totalTokens), 'in: ' + fmtK(summary.totalInputTokens) + ' / out: ' + fmtK(summary.totalOutputTokens) + ' / cached: ' + fmtK(summary.totalCachedTokens), '', tokenSpark) +
      kpi('Est. Cost', fmtCost(summary.totalCost), summary.totalRuns > 0 ? fmtCost(summary.totalCost / summary.totalRuns) + '/run' : '', '', costSpark) +
      kpi('Heartbeat OK', fmtPct(efficiency.heartbeatOkRate), efficiency.heartbeatOkRuns + ' / ' + efficiency.totalRuns + ' runs', efficiency.heartbeatOkRate >= 0.8 ? 'green' : efficiency.heartbeatOkRate >= 0.5 ? 'yellow' : 'red') +
      kpi('Error Rate', fmtPct(efficiency.errorRate), efficiency.errorRuns + ' error runs · ' + efficiency.sessionsWithErrors + ' sessions', efficiency.errorRate <= 0.05 ? 'green' : efficiency.errorRate <= 0.15 ? 'yellow' : 'red') +
      kpi('MCP Servers', fmt(mcpServers.length), mcpUnhealthy > 0 ? mcpUnhealthy + ' unhealthy' : mcpErrors > 0 ? mcpErrors + ' tool errors' : 'all healthy', mcpUnhealthy > 0 ? 'red' : mcpErrors > 0 ? 'yellow' : 'green');

    // ── Zone 2: Timeline chart ──
    document.getElementById('timeline-badge').textContent = timeline.length + ' days';
    if (timelineChart) timelineChart.destroy();
    const zoomHint = document.getElementById('zoom-hint');
    timelineChart = new Chart(document.getElementById('timelineChart'), {
      type: 'bar',
      data: {
        labels: timeline.map(d => { const dt = new Date(d.date); return dt.toLocaleDateString('en-US', { month:'short', day:'numeric' }); }),
        datasets: [{
          label: 'Input Tokens', data: timeline.map(d => d.inputTokens),
          backgroundColor: '#7b68ee40', borderColor: '#7b68ee', borderWidth: 1, borderRadius: 3, stack: 'tokens', order: 2,
        },{
          label: 'Output Tokens', data: timeline.map(d => d.outputTokens),
          backgroundColor: '#e06c7540', borderColor: '#e06c75', borderWidth: 1, borderRadius: 3, stack: 'tokens', order: 2,
        },{
          label: 'Cost ($)', data: timeline.map(d => d.cost),
          type: 'line', borderColor: '#3dd68c', backgroundColor: '#3dd68c20',
          borderWidth: 2, pointRadius: 0, pointHoverRadius: 4, fill: true, tension: 0.3, yAxisID: 'y1', order: 1,
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: { position: 'top', align: 'end', labels: { boxWidth: 10, padding: 16, font: { size: 11 } } },
          tooltip: { backgroundColor: '#181c28ee', borderColor: '#343b50', borderWidth: 1, titleFont: { size: 12 }, bodyFont: { size: 11 }, padding: 10, cornerRadius: 6,
            callbacks: { label: function(ctx) { return ctx.dataset.label === 'Cost ($)' ? 'Cost: $' + ctx.parsed.y.toFixed(4) : ctx.dataset.label + ': ' + ctx.parsed.y.toLocaleString() + ' tokens'; } }
          },
          zoom: { zoom: { drag: { enabled: true, backgroundColor: '#7b68ee20', borderColor: '#7b68ee', borderWidth: 1 }, mode: 'x', onZoomComplete: function() { zoomHint.classList.add('visible'); } } },
        },
        scales: {
          x: { stacked: true, grid: { display: false } },
          y: { position: 'left', stacked: true, title: { display: true, text: 'Tokens', font: { size: 10 } }, grid: { color: '#232838' } },
          y1: { position: 'right', title: { display: true, text: 'Cost ($)', font: { size: 10 } }, grid: { drawOnChartArea: false } },
        },
      },
    });
    document.getElementById('timelineChart').addEventListener('dblclick', function() { timelineChart.resetZoom(); zoomHint.classList.remove('visible'); });

    // ── Zone 2: Doughnuts ──
    const compactDoughnut = {
      responsive: true, maintainAspectRatio: false, cutout: '60%',
      plugins: {
        legend: { position: 'right', labels: { padding: 8, font: { size: 10 }, boxWidth: 8 } },
        tooltip: { backgroundColor: '#181c28ee', borderColor: '#343b50', borderWidth: 1, cornerRadius: 6, padding: 8, bodyFont: { size: 11 } },
      },
    };

    if (triggerChart) triggerChart.destroy();
    triggerChart = new Chart(document.getElementById('triggerChart'), {
      type: 'doughnut',
      data: { labels: triggers.map(t => t.trigger), datasets: [{ data: triggers.map(t => t.runs), backgroundColor: COLORS, borderWidth: 0, hoverBorderWidth: 2, hoverBorderColor: '#fff' }] },
      options: { ...compactDoughnut, plugins: { ...compactDoughnut.plugins, tooltip: { ...compactDoughnut.plugins.tooltip, callbacks: { label: function(ctx) { return ctx.label + ': ' + ctx.parsed + ' runs'; } } } } },
    });

    if (modelChart) modelChart.destroy();
    const models = Object.entries(summary.byModel);
    modelChart = new Chart(document.getElementById('modelChart'), {
      type: 'doughnut',
      data: { labels: models.map(([m]) => m), datasets: [{ data: models.map(([,v]) => v.tokens), backgroundColor: COLORS.slice(3), borderWidth: 0, hoverBorderWidth: 2, hoverBorderColor: '#fff' }] },
      options: { ...compactDoughnut, plugins: { ...compactDoughnut.plugins, tooltip: { ...compactDoughnut.plugins.tooltip,
        callbacks: { label: function(ctx) { const v = models[ctx.dataIndex][1]; return [ctx.label + ': ' + ctx.parsed.toLocaleString() + ' tokens', '  in: ' + v.inputTokens.toLocaleString() + ' / out: ' + v.outputTokens.toLocaleString() + ' / cached: ' + v.cachedTokens.toLocaleString()]; } } } } },
    });

    if (costModelChart) costModelChart.destroy();
    const costData = models.map(([,v]) => v.cost);
    const hasCostData = costData.some(c => c > 0);
    const costCanvas = document.getElementById('costModelChart');
    if (hasCostData) {
      costCanvas.style.display = '';
      costCanvas.parentElement.querySelector('.empty-chart')?.remove();
      costModelChart = new Chart(costCanvas, {
        type: 'doughnut',
        data: { labels: models.map(([m]) => m), datasets: [{ data: costData, backgroundColor: COLORS.slice(1), borderWidth: 0, hoverBorderWidth: 2, hoverBorderColor: '#fff' }] },
        options: { ...compactDoughnut, plugins: { ...compactDoughnut.plugins, tooltip: { ...compactDoughnut.plugins.tooltip, callbacks: { label: function(ctx) { return ctx.label + ': $' + ctx.parsed.toFixed(4); } } } } },
      });
    } else {
      costCanvas.style.display = 'none';
      if (!costCanvas.parentElement.querySelector('.empty-chart')) {
        costCanvas.parentElement.insertAdjacentHTML('beforeend', '<div class="empty-chart" style="color:var(--muted);font-size:0.78rem;text-align:center">No cost data</div>');
      }
    }

    // ── Zone 3: Skills table ──
    const skillTbody = document.querySelector('#skillTable tbody');
    const skillEmpty = document.getElementById('skillEmpty');
    if (skills.length === 0) { skillEmpty.style.display = ''; skillTbody.innerHTML = ''; }
    else {
      skillEmpty.style.display = 'none';
      const maxSkillCount = skills[0].count;
      skillTbody.innerHTML = skills.map((s, i) => {
        const pct = (s.count / maxSkillCount * 100).toFixed(1);
        const breakdown = Object.entries(s.byTrigger).map(([k,v]) => '<span style="color:var(--text-secondary)">' + esc(k) + '</span>:' + v).join('  ');
        return '<tr><td style="color:var(--muted)">' + (i+1) + '</td><td class="mono">' + esc(s.name) + '</td>' +
          '<td class="bar-cell"><div class="bar-fill" style="width:' + pct + '%;background:var(--purple)"></div>' + fmt(s.count) + '</td>' +
          '<td style="font-size:0.7rem">' + breakdown + '</td></tr>';
      }).join('');
    }

    // ── Zone 3: MCP Servers ──
    const mcpToolStats = mcp.toolStats || [];
    // Build per-server usage stats keyed by normalized name
    const mcpUsageMap = {};
    for (const t of mcpToolStats) {
      if (!mcpUsageMap[t.server]) mcpUsageMap[t.server] = {};
      mcpUsageMap[t.server][t.tool] = { calls: t.calls, errors: t.errors };
    }

    document.getElementById('mcp-badge').textContent = mcpServers.length + ' servers';
    const mcpGrid = document.getElementById('mcp-grid');
    if (mcpServers.length === 0) {
      mcpGrid.innerHTML = '<div class="mcp-empty">No MCP servers configured</div>';
    } else {
      mcpGrid.innerHTML = mcpServers.map((s, idx) => {
        const probe = mcpProbeMap[s.name] || { healthy: false, tools: [] };
        const normName = s.name.replace(/-/g, '_');
        const usage = mcpUsageMap[normName] || mcpUsageMap[s.name] || {};
        const totalCalls = Object.values(usage).reduce((a, u) => a + u.calls, 0);
        const totalErrors = Object.values(usage).reduce((a, u) => a + u.errors, 0);
        const isBuiltIn = !!s.builtIn;

        // Determine status from probe health + usage
        const dotClass = !probe.healthy ? 'error' : totalErrors > 0 ? 'active' : 'healthy';

        // Merge discovered tools (from probe) with usage stats
        const discoveredTools = probe.tools || [];
        const toolNames = new Set(discoveredTools.map(t => t.name));
        // Add tools only seen in usage (shouldn't happen normally, but handles edge cases)
        for (const name of Object.keys(usage)) { toolNames.add(name); }

        const mergedTools = Array.from(toolNames).map(name => {
          const desc = discoveredTools.find(t => t.name === name);
          const u = usage[name] || { calls: 0, errors: 0 };
          return { name, description: desc?.description, calls: u.calls, errors: u.errors };
        }).sort((a, b) => b.calls - a.calls || a.name.localeCompare(b.name));

        const toolRows = mergedTools.length > 0
          ? mergedTools.map(t => {
              const callsLabel = t.calls > 0 ? fmt(t.calls) + ' calls' : '<span style="color:var(--muted)">unused</span>';
              return '<div class="mcp-tool-row">' +
                '<span class="mcp-tool-name">' + esc(t.name) + '</span>' +
                (t.description ? '<span class="mcp-tool-desc" title="' + esc(t.description) + '">ℹ</span>' : '') +
                '<span class="mcp-tool-calls">' + callsLabel + '</span>' +
                (t.errors > 0 ? '<span class="mcp-tool-err">' + t.errors + ' err</span>' : '') +
              '</div>';
            }).join('')
          : '<div class="mcp-no-tools">' + (probe.healthy ? 'No tools exposed' : 'Probe failed: ' + esc(probe.error || 'unknown')) + '</div>';

        const statusHint = !probe.healthy ? ' · <span style="color:var(--red)">unhealthy</span>' : '';
        return '<div class="mcp-row" onclick="toggleMcpTools(' + idx + ')">' +
          '<span class="mcp-chevron" id="mcp-chev-' + idx + '">&#9654;</span>' +
          '<div class="mcp-dot ' + dotClass + '"></div>' +
          '<span class="mcp-name">' + esc(s.name) + '</span>' +
          '<span class="mcp-badge ' + (isBuiltIn ? 'built-in' : 'external') + '">' + (isBuiltIn ? 'built-in' : 'external') + '</span>' +
          '<span class="mcp-stats">' + mergedTools.length + ' tools · ' + fmt(totalCalls) + ' calls' + (totalErrors > 0 ? ' · <span style="color:var(--red)">' + totalErrors + ' err</span>' : '') + statusHint + '</span>' +
        '</div>' +
        '<div class="mcp-tools" id="mcp-tools-' + idx + '">' + toolRows + '</div>';
      }).join('');
    }

    // ── Zone 3: Unified tool table (all tools with MCP server column) ──
    const toolTbody = document.querySelector('#toolTable tbody');
    // Enrich tool data with server info from MCP stats
    const mcpToolMap = {};
    for (const t of mcpToolStats) { mcpToolMap[t.server + '__' + t.tool] = t.server; }
    const enrichedTools = tools.slice(0, 20).map(t => {
      const sepIdx = t.name.indexOf('__');
      let server = '';
      if (sepIdx !== -1) { server = t.name.substring(0, sepIdx); }
      return { ...t, server };
    });
    const maxCount = enrichedTools.length > 0 ? enrichedTools[0].count : 1;
    toolTbody.innerHTML = enrichedTools.map((t, i) => {
      const pct = (t.count / maxCount * 100).toFixed(1);
      const breakdown = Object.entries(t.byTrigger).map(([k,v]) => '<span style="color:var(--text-secondary)">' + esc(k) + '</span>:' + v).join('  ');
      const serverLabel = t.server ? '<span style="color:var(--cyan)">' + esc(t.server) + '</span>' : '<span style="color:var(--muted)">built-in</span>';
      return '<tr><td style="color:var(--muted)">' + (i+1) + '</td><td class="mono">' + esc(t.name) + '</td>' +
        '<td style="font-size:0.7rem">' + serverLabel + '</td>' +
        '<td class="bar-cell"><div class="bar-fill" style="width:' + pct + '%;background:var(--accent)"></div>' + fmt(t.count) + '</td>' +
        '<td style="font-size:0.7rem">' + breakdown + '</td></tr>';
    }).join('');

    // ── Zone 4: Error rate chart ──
    if (errorRateChart) errorRateChart.destroy();
    if (errors.length === 0) {
      errorRateChart = new Chart(document.getElementById('errorRateChart'), {
        type: 'bar', data: { labels: [], datasets: [] },
        options: { responsive: true, plugins: { title: { display: true, text: 'No errors in this period', color: '#636b7e' } } },
      });
    } else {
      const top15 = errors.slice(0, 15);
      errorRateChart = new Chart(document.getElementById('errorRateChart'), {
        type: 'bar',
        data: {
          labels: top15.map(e => e.name.length > 24 ? e.name.slice(0,24) + '…' : e.name),
          datasets: [{ label: 'Error Rate',
            data: top15.map(e => (e.errorRate * 100)),
            backgroundColor: top15.map(e => e.errorRate >= 0.3 ? '#f0606040' : e.errorRate >= 0.1 ? '#f0c04040' : '#3dd68c40'),
            borderColor: top15.map(e => e.errorRate >= 0.3 ? '#f06060' : e.errorRate >= 0.1 ? '#f0c040' : '#3dd68c'),
            borderWidth: 1, borderRadius: 3,
          }]
        },
        options: {
          responsive: true, indexAxis: 'y', maintainAspectRatio: false,
          scales: { x: { title: { display: true, text: 'Error Rate (%)', font: { size: 10 } }, max: 100, grid: { color: '#232838' } } },
          plugins: { legend: { display: false },
            tooltip: { backgroundColor: '#181c28ee', borderColor: '#343b50', borderWidth: 1, cornerRadius: 6, padding: 10,
              callbacks: { label: function(ctx) { return ctx.parsed.x.toFixed(1) + '%'; } } },
          },
        },
      });
    }

    // ── Zone 4: Retry table ──
    const retryTbody = document.querySelector('#retryTable tbody');
    const retryEmpty = document.getElementById('retryEmpty');
    if (retries.length === 0) { retryEmpty.style.display = ''; retryTbody.innerHTML = ''; }
    else {
      retryEmpty.style.display = 'none';
      retryTbody.innerHTML = retries.map(r =>
        '<tr><td class="mono">' + esc(r.tool) + '</td><td>' + fmt(r.occurrences) + '</td>' +
        '<td><span class="retry-streak">' + r.maxStreak + 'x</span></td><td>' + r.avgStreak.toFixed(1) + '</td></tr>'
      ).join('');
    }

    // ── Zone 4: Error patterns table ──
    const patternTbody = document.querySelector('#errorPatternTable tbody');
    const patternEmpty = document.getElementById('patternEmpty');
    if (errorPatterns.length === 0) { patternEmpty.style.display = ''; patternTbody.innerHTML = ''; }
    else {
      patternEmpty.style.display = 'none';
      patternTbody.innerHTML = errorPatterns.map((p, i) =>
        '<tr><td style="color:var(--muted)">' + (i+1) + '</td><td class="error-msg">' + esc(p.message) + '</td><td>' + fmt(p.count) + '</td><td class="mono" style="color:var(--text-secondary)">' + p.tools.map(esc).join(', ') + '</td></tr>'
      ).join('');
    }

    // ── Done ──
    bar.style.width = '100%';
    setTimeout(() => { bar.style.width = '0'; bar.style.transition = 'none'; requestAnimationFrame(() => { bar.style.transition = 'width .3s'; }); }, 400);
  }

  // ── Event listeners ──
  document.getElementById('time-pills').addEventListener('click', e => {
    if (e.target.dataset && e.target.dataset.range) { customSince = null; customTo = null; fpFrom.clear(); fpTo.clear(); loadDashboard(e.target.dataset.range); }
  });

  function onCustomRangeChange() {
    const from = fpFrom.selectedDates[0];
    const to = fpTo.selectedDates[0];
    if (from) {
      customSince = from.toISOString().slice(0, 10);
      customTo = to ? to.toISOString().slice(0, 10) : null;
      document.querySelectorAll('#time-pills button').forEach(b => b.classList.remove('active'));
      loadDashboard(currentRange);
    }
  }
  const fpOpts = { dateFormat: 'Y-m-d', theme: 'dark', disableMobile: true, onChange: function() { setTimeout(onCustomRangeChange, 0); } };
  const fpFrom = flatpickr('#date-from', { ...fpOpts, placeholder: 'From' });
  const fpTo = flatpickr('#date-to', { ...fpOpts, placeholder: 'To' });

  loadDashboard('7d');
})();
</script>
</body>
</html>`;
}
