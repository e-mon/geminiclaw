/**
 * dashboard/pool-page.ts — Dedicated full-page view for the ACP Process Pool.
 *
 * Option C: Shows detailed real-time process pool status with large
 * visualizations, per-process cards, capacity timeline, and controls.
 * Auto-refreshes every 3 seconds.
 */

export function renderPoolPageHTML(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeminiClaw — Process Pool</title>
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

  /* ── Capacity header ────────────────────────────── */
  .cap-header { display: flex; align-items: flex-end; gap: 32px; margin-bottom: 24px; }
  .cap-ring { position: relative; width: 120px; height: 120px; flex-shrink: 0; }
  .cap-ring svg { transform: rotate(-90deg); }
  .cap-ring-bg { fill: none; stroke: var(--border); stroke-width: 8; }
  .cap-ring-fill { fill: none; stroke-width: 8; stroke-linecap: round; transition: stroke-dashoffset .6s, stroke .3s; }
  .cap-ring-center { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; }
  .cap-ring-pct { font-size: 1.8rem; font-weight: 800; font-variant-numeric: tabular-nums; }
  .cap-ring-lbl { font-size: 0.65rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.04em; margin-top: 2px; }
  .cap-stats { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; flex: 1; }
  .cap-stat { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; }
  .cap-stat-val { font-size: 1.6rem; font-weight: 700; font-variant-numeric: tabular-nums; }
  .cap-stat-lbl { font-size: 0.62rem; color: var(--muted); text-transform: uppercase; letter-spacing: 0.05em; margin-top: 3px; }

  /* ── Capacity bar ───────────────────────────────── */
  .cap-bar-wrap { margin-bottom: 24px; }
  .cap-bar-labels { display: flex; justify-content: space-between; font-size: 0.65rem; color: var(--muted); margin-bottom: 6px; }
  .cap-bar { height: 14px; background: var(--bg-raised); border-radius: 7px; overflow: hidden; display: flex; border: 1px solid var(--border); }
  .cap-seg { height: 100%; transition: width .5s; }
  .cap-seg.in-use { background: linear-gradient(90deg, #f09040, #f0c040); }
  .cap-seg.idle { background: linear-gradient(90deg, #3dd68c, #40d0d0); }
  .cap-seg.reserved { background: repeating-linear-gradient(45deg, var(--border), var(--border) 2px, transparent 2px, transparent 5px); }
  .cap-bar-legend { display: flex; gap: 16px; margin-top: 8px; font-size: 0.68rem; color: var(--text-secondary); }
  .cap-bar-legend span { display: flex; align-items: center; gap: 5px; }
  .cap-bar-legend .leg-sq { width: 10px; height: 10px; border-radius: 2px; }
  .leg-sq.in-use { background: var(--orange); }
  .leg-sq.idle { background: var(--green); }
  .leg-sq.reserved { background: repeating-linear-gradient(45deg, var(--border), var(--border) 2px, transparent 2px, transparent 4px); }
  .leg-sq.free { background: var(--bg-raised); border: 1px solid var(--border); }

  /* ── Process cards ──────────────────────────────── */
  .procs-title { font-size: 0.82rem; font-weight: 600; margin-bottom: 12px; }
  .procs-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 10px; }
  .proc-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 14px 16px; display: flex; gap: 12px; align-items: flex-start; transition: border-color .15s; }
  .proc-card:hover { border-color: var(--border-hover); }
  .proc-status-ring { width: 36px; height: 36px; border-radius: 50%; display: flex; align-items: center; justify-content: center; font-size: 0.85rem; flex-shrink: 0; }
  .proc-status-ring.idle { background: var(--green-dim); color: var(--green); }
  .proc-status-ring.in-use { background: #f0904020; color: var(--orange); }
  .proc-status-ring.closed { background: var(--red-dim); color: var(--red); }
  .proc-details { flex: 1; min-width: 0; }
  .proc-top { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
  .proc-idx { font-size: 0.72rem; font-weight: 600; }
  .proc-badge { font-size: 0.62rem; padding: 2px 8px; border-radius: 10px; font-weight: 600; }
  .proc-badge.idle { background: var(--green-dim); color: var(--green); }
  .proc-badge.in-use { background: #f0904025; color: var(--orange); }
  .proc-badge.closed { background: var(--red-dim); color: var(--red); }
  .proc-key { font-family: var(--font-mono); font-size: 0.68rem; color: var(--text-secondary); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
  .proc-meta { display: flex; gap: 10px; flex-wrap: wrap; }
  .proc-meta-item { font-size: 0.65rem; color: var(--muted); }
  .proc-meta-item strong { color: var(--text-secondary); font-weight: 500; }

  /* ── Empty slots ────────────────────────────────── */
  .empty-slots { margin-top: 16px; }
  .empty-slots-title { font-size: 0.75rem; color: var(--muted); margin-bottom: 8px; }
  .empty-slot-grid { display: flex; gap: 8px; flex-wrap: wrap; }
  .empty-slot { width: 44px; height: 44px; border: 1px dashed var(--border); border-radius: 6px; display: flex; align-items: center; justify-content: center; color: var(--border-hover); font-size: 1rem; }

  /* ── Empty state ────────────────────────────────── */
  .pool-empty-state { text-align: center; padding: 60px 24px; }
  .pool-empty-icon { font-size: 2.5rem; margin-bottom: 12px; opacity: 0.3; }
  .pool-empty-text { color: var(--muted); font-size: 0.85rem; }
</style>
</head>
<body>

<div class="topnav">
  <div class="topnav-left">
    <div class="topnav-logo"><span>Gemini</span>Claw</div>
    <div class="topnav-tabs">
      <a href="/dashboard">Overview</a>
      <a href="/dashboard/runs">Runs</a>
      <a href="/dashboard/pool" class="active">Pool</a>
    </div>
  </div>
  <div class="topnav-right">
    <div class="live-badge"><div class="live-dot"></div> Live</div>
    <span class="refresh-info" id="refresh-info">—</span>
  </div>
</div>

<div class="content">
  <!-- Capacity header -->
  <div class="cap-header" id="cap-header">
    <div class="cap-ring" id="cap-ring">
      <svg viewBox="0 0 120 120" width="120" height="120">
        <circle class="cap-ring-bg" cx="60" cy="60" r="52"/>
        <circle class="cap-ring-fill" id="cap-ring-fill" cx="60" cy="60" r="52" stroke="var(--accent)" stroke-dasharray="326.7" stroke-dashoffset="326.7"/>
      </svg>
      <div class="cap-ring-center">
        <span class="cap-ring-pct" id="cap-pct">0%</span>
        <span class="cap-ring-lbl">utilization</span>
      </div>
    </div>
    <div class="cap-stats" id="cap-stats"></div>
  </div>

  <!-- Capacity bar -->
  <div class="cap-bar-wrap" id="cap-bar-wrap"></div>

  <!-- Process cards -->
  <div class="procs-title" id="procs-title">Processes</div>
  <div class="procs-grid" id="procs-grid"></div>

  <!-- Empty slots -->
  <div class="empty-slots" id="empty-slots"></div>
</div>

<script>
(function() {
  function esc(s) { const d = document.createElement('div'); d.textContent = s; return d.innerHTML; }
  function timeAgo(ms) {
    if (!ms) return '—';
    const sec = Math.floor((Date.now() - ms) / 1000);
    if (sec < 60) return sec + 's ago';
    if (sec < 3600) return Math.floor(sec / 60) + 'm ago';
    return Math.floor(sec / 3600) + 'h ago';
  }

  async function refresh() {
    try {
      const data = await (await fetch('/api/dashboard/pool')).json();
      const entries = data.entries;
      const total = entries.length;
      const inUse = entries.filter(e => e.inUse).length;
      const idle = entries.filter(e => !e.inUse && !e.closed).length;
      const closed = entries.filter(e => e.closed).length;
      const max = data.maxSize;
      const reserved = data.reservedSlots;
      const free = max - total;
      const pct = max > 0 ? Math.round(total / max * 100) : 0;

      // Ring
      const circ = 2 * Math.PI * 52;
      const offset = circ - (circ * total / Math.max(max, 1));
      const ringColor = pct >= 90 ? 'var(--red)' : pct >= 70 ? 'var(--orange)' : 'var(--accent)';
      document.getElementById('cap-ring-fill').setAttribute('stroke-dashoffset', String(offset));
      document.getElementById('cap-ring-fill').setAttribute('stroke', ringColor);
      document.getElementById('cap-pct').textContent = pct + '%';

      // Stats
      document.getElementById('cap-stats').innerHTML =
        '<div class="cap-stat"><div class="cap-stat-val">' + max + '</div><div class="cap-stat-lbl">Max Capacity</div></div>' +
        '<div class="cap-stat"><div class="cap-stat-val" style="color:var(--orange)">' + inUse + '</div><div class="cap-stat-lbl">In Use</div></div>' +
        '<div class="cap-stat"><div class="cap-stat-val" style="color:var(--green)">' + idle + '</div><div class="cap-stat-lbl">Idle</div></div>' +
        '<div class="cap-stat"><div class="cap-stat-val' + (data.waiting > 0 ? '" style="color:var(--red)' : '') + '">' + data.waiting + '</div><div class="cap-stat-lbl">Wait Queue</div></div>';

      // Capacity bar
      const barInUse = max > 0 ? (inUse / max * 100) : 0;
      const barIdle = max > 0 ? (idle / max * 100) : 0;
      const barReserved = max > 0 ? (reserved / max * 100) : 0;
      document.getElementById('cap-bar-wrap').innerHTML =
        '<div class="cap-bar-labels"><span>0</span><span>Effective (' + (max - reserved) + ')</span><span>Max (' + max + ')</span></div>' +
        '<div class="cap-bar">' +
          '<div class="cap-seg in-use" style="width:' + barInUse + '%"></div>' +
          '<div class="cap-seg idle" style="width:' + barIdle + '%"></div>' +
        '</div>' +
        '<div class="cap-bar-legend">' +
          '<span><div class="leg-sq in-use"></div>' + inUse + ' in use</span>' +
          '<span><div class="leg-sq idle"></div>' + idle + ' idle</span>' +
          '<span><div class="leg-sq reserved"></div>' + reserved + ' reserved</span>' +
          '<span><div class="leg-sq free"></div>' + free + ' free</span>' +
        '</div>';

      // Process cards
      document.getElementById('procs-title').textContent = 'Processes (' + total + ')';
      if (total === 0) {
        document.getElementById('procs-grid').innerHTML =
          '<div class="pool-empty-state"><div class="pool-empty-icon">○</div><div class="pool-empty-text">No active processes in the pool</div></div>';
      } else {
        document.getElementById('procs-grid').innerHTML = entries.map((e, i) => {
          const st = e.closed ? 'closed' : e.inUse ? 'in-use' : 'idle';
          const icon = st === 'in-use' ? '▶' : st === 'idle' ? '○' : '✕';
          const key = e.key.length > 40 ? '…' + e.key.slice(-40) : e.key;
          const sid = e.lastSessionId ? e.lastSessionId.substring(0, 12) : '—';
          return '<div class="proc-card">' +
            '<div class="proc-status-ring ' + st + '">' + icon + '</div>' +
            '<div class="proc-details">' +
              '<div class="proc-top"><span class="proc-idx">#' + (i + 1) + '</span><span class="proc-badge ' + st + '">' + st.replace('-', ' ') + '</span></div>' +
              '<div class="proc-key" title="' + esc(e.key) + '">' + esc(key) + '</div>' +
              '<div class="proc-meta">' +
                '<div class="proc-meta-item"><strong>Session:</strong> ' + esc(sid) + '</div>' +
                '<div class="proc-meta-item"><strong>Last used:</strong> ' + timeAgo(e.lastUsedAt) + '</div>' +
              '</div>' +
            '</div>' +
          '</div>';
        }).join('');
      }

      // Empty slots
      if (free > 0) {
        document.getElementById('empty-slots').innerHTML =
          '<div class="empty-slots-title">' + free + ' available slot' + (free > 1 ? 's' : '') + '</div>' +
          '<div class="empty-slot-grid">' + Array(free).fill('<div class="empty-slot">+</div>').join('') + '</div>';
      } else {
        document.getElementById('empty-slots').innerHTML = '';
      }

      // Refresh info
      document.getElementById('refresh-info').textContent = 'Updated ' + new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    } catch (err) {
      document.getElementById('refresh-info').textContent = 'Error fetching pool data';
    }
  }

  refresh();
  setInterval(refresh, 3000);
})();
</script>
</body>
</html>`;
}
