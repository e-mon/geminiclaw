/**
 * dashboard/mcp-page.ts — MCP server status page.
 *
 * Shows registered MCP servers, their configuration, and live tool call
 * statistics from session event logs. Auto-refreshes every 5 seconds.
 */

export function renderMcpPageHTML(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeminiClaw — MCP Servers</title>
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
  .topnav-right { display: flex; align-items: center; gap: 10px; }
  .live-badge { display: flex; align-items: center; gap: 5px; font-size: 0.7rem; color: var(--green); }
  .live-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--green); animation: pulse 2s infinite; }
  @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
  .refresh-info { font-size: 0.68rem; color: var(--muted); font-family: var(--font-mono); }

  /* ── Content ────────────────────────────────────── */
  .content { padding: 24px; max-width: 1200px; margin: 0 auto; }

  /* ── Summary KPIs ──────────────────────────────── */
  .kpi-row { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; margin-bottom: 24px; }
  .kpi { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .kpi-val { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .kpi-lbl { font-size: 0.62rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 3px; }

  /* ── Server cards ──────────────────────────────── */
  .section-title { font-size: 0.85rem; font-weight: 600; margin-bottom: 12px; }
  .server-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 12px; margin-bottom: 24px; }
  .server-card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; overflow: hidden; transition: border-color .15s; }
  .server-card:hover { border-color: var(--border-hover); }
  .server-header { display: flex; align-items: center; gap: 10px; padding: 14px 16px; border-bottom: 1px solid var(--border); }
  .server-dot { width: 10px; height: 10px; border-radius: 50%; flex-shrink: 0; }
  .server-dot.active { background: var(--green); box-shadow: 0 0 6px var(--green); }
  .server-dot.idle { background: var(--muted); }
  .server-dot.error { background: var(--red); box-shadow: 0 0 6px var(--red); }
  .server-name { font-weight: 600; font-size: 0.85rem; flex: 1; }
  .server-badge { font-size: 0.62rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .server-badge.built-in { background: var(--accent-dim); color: var(--accent); }
  .server-badge.external { background: var(--green-dim); color: var(--green); }
  .server-body { padding: 12px 16px; }
  .server-cmd { font-family: var(--font-mono); font-size: 0.7rem; color: var(--text-secondary); background: var(--bg); padding: 6px 10px; border-radius: 4px; margin-bottom: 10px; white-space: nowrap; overflow-x: auto; }
  .server-stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
  .server-stat { text-align: center; }
  .server-stat-val { font-size: 1.1rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .server-stat-lbl { font-size: 0.58rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; }
  .server-tools { margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--border); }
  .server-tools-title { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-bottom: 6px; }
  .tool-list { display: flex; flex-wrap: wrap; gap: 4px; }
  .tool-chip { font-family: var(--font-mono); font-size: 0.65rem; padding: 2px 8px; background: var(--bg); border-radius: 4px; color: var(--text-secondary); border: 1px solid var(--border); }
  .tool-chip.has-calls { border-color: var(--accent); color: var(--accent); }
  .tool-chip.has-errors { border-color: var(--red); color: var(--red); }

  /* ── Tool call table ───────────────────────────── */
  .panel { background: var(--card); border: 1px solid var(--border); border-radius: 8px; overflow: hidden; }
  .panel-head { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--border); }
  .panel-title { font-size: 0.78rem; font-weight: 600; }
  .panel-badge { font-size: 0.68rem; color: var(--muted); padding: 2px 8px; background: var(--bg); border-radius: 4px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.78rem; }
  th { color: var(--muted); font-weight: 500; text-transform: uppercase; font-size: 0.65rem; letter-spacing: 0.05em; padding: 8px 12px; text-align: left; border-bottom: 1px solid var(--border); }
  td { padding: 7px 12px; border-bottom: 1px solid var(--border); }
  tr:hover td { background: #ffffff04; }
  .mono { font-family: var(--font-mono); font-size: 0.72rem; }
  .badge { display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 10px; font-size: 0.68rem; font-weight: 600; }
  .badge-green { background: var(--green-dim); color: var(--green); }
  .badge-red { background: var(--red-dim); color: var(--red); }
  .badge-yellow { background: var(--yellow-dim); color: var(--yellow); }
  .empty { color: var(--muted); font-style: italic; padding: 24px; text-align: center; font-size: 0.8rem; }
  .bar-cell { position: relative; }
  .bar-fill { position: absolute; left: 0; top: 3px; bottom: 3px; opacity: 0.12; border-radius: 3px; }
</style>
</head>
<body>

<div class="topnav">
  <div class="topnav-left">
    <div class="topnav-logo"><span>Gemini</span>Claw</div>
    <div class="topnav-tabs">
      <a href="/dashboard">Overview</a>
      <a href="/dashboard/runs">Runs</a>
      <a href="/dashboard/pool">Pool</a>
      <a href="/dashboard/mcp" class="active">MCP</a>
    </div>
  </div>
  <div class="topnav-right">
    <div class="live-badge"><div class="live-dot"></div> Live</div>
    <span class="refresh-info" id="refresh-info">—</span>
  </div>
</div>

<div class="content">
  <div class="kpi-row" id="kpi-row"></div>
  <div class="section-title">Registered Servers</div>
  <div class="server-grid" id="server-grid"></div>
  <div class="section-title" style="margin-top:24px">MCP Tool Calls (Recent Sessions)</div>
  <div class="panel">
    <div class="panel-head">
      <span class="panel-title">Tool Activity</span>
      <span class="panel-badge" id="tool-badge"></span>
    </div>
    <div id="tool-table-wrap" style="padding:0">
      <table id="tool-table">
        <thead><tr><th>Server</th><th>Tool</th><th style="width:80px">Calls</th><th style="width:80px">Errors</th><th style="width:80px">Rate</th></tr></thead>
        <tbody></tbody>
      </table>
      <div class="empty" id="tool-empty" style="display:none">No MCP tool calls in recent sessions</div>
    </div>
  </div>
</div>

<script>
(function() {
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function fmt(n) { return typeof n === 'number' ? n.toLocaleString() : '0'; }
  function fmtPct(n) { return (n * 100).toFixed(1) + '%'; }
  function rateBadge(rate) {
    if (rate >= 0.3) return '<span class="badge badge-red">' + fmtPct(rate) + '</span>';
    if (rate >= 0.1) return '<span class="badge badge-yellow">' + fmtPct(rate) + '</span>';
    return '<span class="badge badge-green">' + fmtPct(rate) + '</span>';
  }

  const BUILTIN_SERVERS = ['geminiclaw-status', 'geminiclaw-ask-user', 'geminiclaw-cron', 'geminiclaw-google', 'geminiclaw-admin', 'qmd'];

  async function refresh() {
    try {
      const data = await (await fetch('/api/dashboard/mcp')).json();
      const servers = data.servers;
      const toolStats = data.toolStats;

      // KPIs
      const totalServers = servers.length;
      const totalTools = toolStats.length;
      const totalCalls = toolStats.reduce((a, t) => a + t.calls, 0);
      const totalErrors = toolStats.reduce((a, t) => a + t.errors, 0);
      document.getElementById('kpi-row').innerHTML =
        '<div class="kpi"><div class="kpi-val">' + totalServers + '</div><div class="kpi-lbl">Servers</div></div>' +
        '<div class="kpi"><div class="kpi-val">' + totalTools + '</div><div class="kpi-lbl">Unique Tools Used</div></div>' +
        '<div class="kpi"><div class="kpi-val">' + fmt(totalCalls) + '</div><div class="kpi-lbl">Total Calls</div></div>' +
        '<div class="kpi"><div class="kpi-val" style="color:' + (totalErrors > 0 ? 'var(--red)' : 'var(--green)') + '">' + fmt(totalErrors) + '</div><div class="kpi-lbl">Errors</div></div>';

      // Server cards
      const serverStatsMap = {};
      for (const t of toolStats) {
        if (!serverStatsMap[t.server]) serverStatsMap[t.server] = { calls: 0, errors: 0, tools: [] };
        serverStatsMap[t.server].calls += t.calls;
        serverStatsMap[t.server].errors += t.errors;
        serverStatsMap[t.server].tools.push(t);
      }

      document.getElementById('server-grid').innerHTML = servers.map(s => {
        const stats = serverStatsMap[s.name] || { calls: 0, errors: 0, tools: [] };
        const isBuiltIn = BUILTIN_SERVERS.includes(s.name);
        const dotClass = stats.errors > 0 ? 'error' : stats.calls > 0 ? 'active' : 'idle';
        const cmd = s.httpUrl ? s.httpUrl : s.command + (s.args && s.args.length > 0 ? ' ' + s.args.join(' ') : '');
        const shortCmd = cmd.length > 60 ? '...' + cmd.slice(-57) : cmd;

        let toolChips = '';
        if (stats.tools.length > 0) {
          toolChips = '<div class="server-tools"><div class="server-tools-title">Tools Used</div><div class="tool-list">' +
            stats.tools.map(t => {
              const cls = t.errors > 0 ? 'has-errors' : t.calls > 0 ? 'has-calls' : '';
              return '<span class="tool-chip ' + cls + '" title="' + t.calls + ' calls, ' + t.errors + ' errors">' + esc(t.tool) + '</span>';
            }).join('') +
          '</div></div>';
        }

        return '<div class="server-card">' +
          '<div class="server-header">' +
            '<div class="server-dot ' + dotClass + '"></div>' +
            '<span class="server-name">' + esc(s.name) + '</span>' +
            '<span class="server-badge ' + (isBuiltIn ? 'built-in' : 'external') + '">' + (isBuiltIn ? 'built-in' : 'external') + '</span>' +
          '</div>' +
          '<div class="server-body">' +
            '<div class="server-cmd" title="' + esc(cmd) + '">' + esc(shortCmd) + '</div>' +
            '<div class="server-stats">' +
              '<div class="server-stat"><div class="server-stat-val">' + fmt(stats.calls) + '</div><div class="server-stat-lbl">Calls</div></div>' +
              '<div class="server-stat"><div class="server-stat-val" style="color:' + (stats.errors > 0 ? 'var(--red)' : 'var(--text)') + '">' + fmt(stats.errors) + '</div><div class="server-stat-lbl">Errors</div></div>' +
              '<div class="server-stat"><div class="server-stat-val">' + stats.tools.length + '</div><div class="server-stat-lbl">Tools</div></div>' +
            '</div>' +
            toolChips +
          '</div>' +
        '</div>';
      }).join('');

      // Tool call table
      document.getElementById('tool-badge').textContent = totalTools + ' tools';
      const tbody = document.querySelector('#tool-table tbody');
      const toolEmpty = document.getElementById('tool-empty');
      if (toolStats.length === 0) {
        toolEmpty.style.display = '';
        tbody.innerHTML = '';
      } else {
        toolEmpty.style.display = 'none';
        const maxCalls = toolStats.length > 0 ? toolStats[0].calls : 1;
        tbody.innerHTML = toolStats.map(t => {
          const pct = (t.calls / maxCalls * 100).toFixed(1);
          const errRate = t.calls > 0 ? t.errors / t.calls : 0;
          return '<tr>' +
            '<td class="mono" style="color:var(--text-secondary)">' + esc(t.server) + '</td>' +
            '<td class="mono">' + esc(t.tool) + '</td>' +
            '<td class="bar-cell"><div class="bar-fill" style="width:' + pct + '%;background:var(--accent)"></div>' + fmt(t.calls) + '</td>' +
            '<td>' + (t.errors > 0 ? '<span style="color:var(--red)">' + fmt(t.errors) + '</span>' : '<span style="color:var(--muted)">0</span>') + '</td>' +
            '<td>' + (t.calls > 0 ? rateBadge(errRate) : '—') + '</td>' +
          '</tr>';
        }).join('');
      }

      document.getElementById('refresh-info').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
    } catch (err) {
      document.getElementById('refresh-info').textContent = 'Error fetching MCP data';
    }
  }

  refresh();
  setInterval(refresh, 5000);
})();
</script>
</body>
</html>`;
}
