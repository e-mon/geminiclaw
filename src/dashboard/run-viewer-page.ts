/**
 * dashboard/run-viewer-page.ts — Self-contained HTML page for the Run Viewer.
 *
 * Displays a list/detail view of agent runs with tool call timelines,
 * summary cards, and filters. Shares the same design tokens and top
 * navigation as the Overview dashboard (page.ts).
 */

export function renderRunViewerHTML(): string {
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>GeminiClaw — Runs</title>
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

  /* ── Top Nav (shared with Overview) ─────────────── */
  .topnav { display: flex; align-items: center; justify-content: space-between; padding: 0 24px; height: 48px; background: var(--bg-raised); border-bottom: 1px solid var(--border); position: sticky; top: 0; z-index: 50; }
  .topnav-left { display: flex; align-items: center; gap: 16px; }
  .topnav-logo { font-weight: 700; font-size: 0.9rem; letter-spacing: -0.02em; }
  .topnav-logo span { color: var(--accent); }
  .topnav-tabs { display: flex; gap: 2px; }
  .topnav-tabs a { color: var(--muted); text-decoration: none; font-size: 0.78rem; padding: 6px 12px; border-radius: 6px; transition: all .12s; }
  .topnav-tabs a:hover { color: var(--text); background: var(--border); }
  .topnav-tabs a.active { color: var(--text); background: var(--accent-dim); }
  .topnav-right { display: flex; align-items: center; gap: 12px; }

  /* ── Pool indicator (top-right) ──────────────────── */
  .pool-indicator { display: flex; align-items: center; gap: 6px; font-size: 0.72rem; color: var(--muted); padding: 4px 10px; border: 1px solid var(--border); border-radius: 6px; cursor: default; position: relative; }
  .pool-dots-inline { display: flex; gap: 3px; }
  .pool-dot-sm { width: 7px; height: 7px; border-radius: 50%; }
  .pool-dot-sm.idle { background: var(--green); }
  .pool-dot-sm.in-use { background: var(--orange); }
  .pool-dot-sm.closed { background: var(--red); }
  .pool-tooltip { display: none; position: absolute; top: 100%; right: 0; margin-top: 6px; background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 16px; font-size: 0.72rem; min-width: 200px; z-index: 100; box-shadow: 0 8px 32px #0008; }
  .pool-indicator:hover .pool-tooltip { display: block; }
  .pool-row { display: flex; justify-content: space-between; padding: 3px 0; }
  .pool-row .pool-lbl { color: var(--muted); }

  /* ── Controls ───────────────────────────────────── */
  .controls { display: flex; gap: 8px; padding: 10px 24px; background: var(--bg-raised); border-bottom: 1px solid var(--border); align-items: center; flex-wrap: wrap; }
  .controls select, .controls input { padding: 4px 10px; border-radius: 4px; border: 1px solid var(--border); background: var(--bg); color: var(--text); font-size: 0.75rem; outline: none; font-family: var(--font-mono); }
  .controls select:focus, .controls input:focus { border-color: var(--accent); }
  .controls label { color: var(--muted); font-size: 0.72rem; margin-right: 2px; }

  /* ── Layout ─────────────────────────────────────── */
  .layout { display: grid; grid-template-columns: 320px 1fr; height: calc(100vh - 96px); }
  @media (max-width: 900px) { .layout { grid-template-columns: 1fr; } .detail-pane { display: none; } .detail-pane.active { display: block; } }

  /* ── Run List (left sidebar) ───────────────────── */
  .run-list { border-right: 1px solid var(--border); overflow-y: auto; background: var(--bg); }
  .run-item { padding: 10px 14px; border-bottom: 1px solid var(--border); cursor: pointer; transition: background .1s; display: flex; gap: 10px; align-items: flex-start; }
  .run-item:hover { background: var(--bg-raised); }
  .run-item.active { background: var(--bg-raised); border-left: 3px solid var(--accent); padding-left: 11px; }

  .run-dot { width: 8px; height: 8px; border-radius: 50%; margin-top: 5px; flex-shrink: 0; }
  .run-dot.ok { background: var(--green); }
  .run-dot.error { background: var(--red); }
  .run-dot.hb-fail { background: var(--yellow); }
  .run-dot.compacted { background: var(--purple); }

  .run-info { flex: 1; min-width: 0; }
  .run-time { font-size: 0.78rem; font-weight: 600; }
  .run-meta { font-size: 0.7rem; color: var(--muted); margin-top: 2px; display: flex; gap: 8px; flex-wrap: wrap; }
  .trigger-badge { font-size: 0.65rem; padding: 1px 6px; border-radius: 4px; font-weight: 600; }
  .trigger-badge.heartbeat { background: var(--green-dim); color: var(--green); }
  .trigger-badge.cron { background: var(--yellow-dim); color: var(--yellow); }
  .trigger-badge.chat { background: var(--accent-dim); color: var(--accent); }
  .trigger-badge.manual { background: #f0904025; color: var(--orange); }
  .trigger-badge.compaction { background: #a07ef025; color: var(--purple); }
  .trigger-badge.default { background: #636b7e20; color: var(--muted); }

  .run-tools-preview { font-size: 0.68rem; color: var(--muted); margin-top: 3px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-family: var(--font-mono); }
  .run-error-preview { font-size: 0.68rem; color: var(--red); margin-top: 2px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

  .load-more { padding: 14px; text-align: center; }
  .load-more button { padding: 6px 20px; border-radius: 4px; border: 1px solid var(--border); background: var(--card); color: var(--text); cursor: pointer; font-size: 0.75rem; transition: border-color .15s; }
  .load-more button:hover { border-color: var(--accent); }

  .list-empty { padding: 40px 16px; text-align: center; color: var(--muted); font-style: italic; font-size: 0.82rem; }

  /* ── Detail Pane (right) ───────────────────────── */
  .detail-pane { overflow-y: auto; padding: 20px 24px; background: var(--bg); }
  .detail-placeholder { display: flex; align-items: center; justify-content: center; height: 100%; color: var(--muted); font-style: italic; font-size: 0.85rem; }

  /* Summary cards */
  .summary-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 8px; margin-bottom: 20px; }
  .summary-card { background: var(--card); border: 1px solid var(--border); border-radius: 8px; padding: 12px 14px; }
  .summary-card .label { color: var(--muted); font-size: 0.65rem; text-transform: uppercase; letter-spacing: 0.05em; }
  .summary-card .value { font-size: 1.2rem; font-weight: 700; margin-top: 3px; font-variant-numeric: tabular-nums; }
  .summary-card .value.green { color: var(--green); }
  .summary-card .value.red { color: var(--red); }
  .summary-card .value.yellow { color: var(--yellow); }

  /* ── Timeline ──────────────────────────────────── */
  .timeline-section { margin-bottom: 20px; }
  .timeline-section h3 { font-size: 0.82rem; font-weight: 600; margin-bottom: 10px; color: var(--text-secondary); }
  .timeline { position: relative; padding-left: 24px; }
  .timeline::before { content: ''; position: absolute; left: 7px; top: 0; bottom: 0; width: 2px; background: var(--border); }

  .tl-item { position: relative; margin-bottom: 10px; animation: fadeSlideIn 0.3s ease-out both; }
  .tl-item:nth-child(1) { animation-delay: 0s; }
  .tl-item:nth-child(2) { animation-delay: 0.04s; }
  .tl-item:nth-child(3) { animation-delay: 0.08s; }
  .tl-item:nth-child(4) { animation-delay: 0.12s; }
  .tl-item:nth-child(5) { animation-delay: 0.16s; }
  .tl-item:nth-child(n+6) { animation-delay: 0.2s; }

  @keyframes fadeSlideIn {
    from { opacity: 0; transform: translateY(8px); }
    to { opacity: 1; transform: translateY(0); }
  }

  .tl-dot { position: absolute; left: -20px; top: 6px; width: 8px; height: 8px; border-radius: 50%; border: 2px solid var(--bg); }
  .tl-dot.file { background: var(--blue); }
  .tl-dot.search { background: var(--purple); }
  .tl-dot.memory { background: var(--green); }
  .tl-dot.shell { background: var(--orange); }
  .tl-dot.other { background: var(--muted); }
  .tl-dot.error { background: var(--red); }

  .tl-card { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 8px 12px; }
  .tl-header { display: flex; align-items: center; gap: 8px; font-size: 0.78rem; }
  .tl-name { font-weight: 600; font-family: var(--font-mono); font-size: 0.75rem; }
  .tl-status { font-size: 0.7rem; }
  .tl-status.ok { color: var(--green); }
  .tl-status.err { color: var(--red); }

  details.tl-expand { margin-top: 6px; }
  details.tl-expand summary { font-size: 0.7rem; color: var(--muted); cursor: pointer; user-select: none; }
  details.tl-expand summary:hover { color: var(--text); }
  .tl-code { margin-top: 6px; background: var(--bg); border: 1px solid var(--border); border-radius: 4px; padding: 8px 12px; font-family: var(--font-mono); font-size: 0.7rem; white-space: pre-wrap; word-break: break-all; max-height: 300px; overflow-y: auto; color: var(--text-secondary); }

  /* ── Response section ──────────────────────────── */
  .response-section { margin-top: 20px; }
  .response-section h3 { font-size: 0.82rem; font-weight: 600; margin-bottom: 8px; color: var(--text-secondary); }
  .response-text { background: var(--card); border: 1px solid var(--border); border-radius: 6px; padding: 14px; font-size: 0.78rem; line-height: 1.6; white-space: pre-wrap; word-break: break-word; max-height: 400px; overflow-y: auto; }

  /* ── Loading ────────────────────────────────────── */
  .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid var(--border); border-top-color: var(--accent); border-radius: 50%; animation: spin 0.6s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-row { display: flex; align-items: center; gap: 8px; padding: 16px; color: var(--muted); font-size: 0.78rem; }
</style>
</head>
<body>

<!-- ── Top Navigation (shared structure) ──────────── -->
<div class="topnav">
  <div class="topnav-left">
    <div class="topnav-logo"><span>Gemini</span>Claw</div>
    <div class="topnav-tabs">
      <a href="/dashboard">Overview</a>
      <a href="/dashboard/runs" class="active">Runs</a>
    </div>
  </div>
  <div class="topnav-right">
    <div class="pool-indicator" id="pool-indicator">
      <span>Pool</span>
      <div class="pool-dots-inline" id="pool-dots-inline"></div>
      <div class="pool-tooltip" id="pool-tooltip">Loading…</div>
    </div>
  </div>
</div>

<!-- ── Controls ────────────────────────────────────── -->
<div class="controls">
  <label for="trigger-filter">Trigger</label>
  <select id="trigger-filter">
    <option value="">All</option>
    <option value="heartbeat">Heartbeat</option>
    <option value="cron">Cron</option>
    <option value="chat">Chat</option>
    <option value="manual">Manual</option>
    <option value="compaction">Compaction</option>
  </select>
  <label for="session-filter">Session</label>
  <select id="session-filter">
    <option value="">All Sessions</option>
  </select>
  <label for="since-filter">Since</label>
  <input type="date" id="since-filter">
</div>

<!-- ── Main Layout ─────────────────────────────────── -->
<div class="layout">
  <div class="run-list" id="run-list">
    <div class="loading-row"><div class="spinner"></div> Loading runs…</div>
  </div>
  <div class="detail-pane" id="detail-pane">
    <div class="detail-placeholder">Select a run to view details</div>
  </div>
</div>

<script>
(function() {
  const PAGE_SIZE = 50;
  let currentOffset = 0;
  let hasMore = false;
  let activeRunKey = '';

  // ── Tool category classification ──
  function toolCategory(name) {
    if (!name) return 'other';
    const n = name.toLowerCase();
    if (n.includes('file') || n.includes('read') || n.includes('write') || n.includes('edit') || n.includes('replace') || n.includes('save')) return 'file';
    if (n.includes('search') || n.includes('browse') || n.includes('web') || n.includes('fetch') || n.includes('snapshot') || n.includes('open_document')) return 'search';
    if (n.includes('memory') || n.includes('recall') || n.includes('remember')) return 'memory';
    if (n.includes('shell') || n.includes('bash') || n.includes('exec') || n.includes('run_command') || n.includes('run_shell') || n.includes('command')) return 'shell';
    return 'other';
  }

  function triggerClass(trigger) {
    if (!trigger) return 'default';
    const t = trigger.toLowerCase();
    if (t === 'compaction') return 'compaction';
    if (t.includes('heartbeat') || t === 'hb') return 'heartbeat';
    if (t.includes('cron')) return 'cron';
    if (t.includes('chat') || t.includes('mention') || t.includes('discord') || t.includes('slack')) return 'chat';
    if (t.includes('manual') || t.includes('cli')) return 'manual';
    return 'default';
  }

  function triggerSymbol(trigger) {
    const cls = triggerClass(trigger);
    if (cls === 'compaction') return 'CPT';
    if (cls === 'heartbeat') return 'HB';
    if (cls === 'cron') return 'CRN';
    if (cls === 'chat') return 'MSG';
    if (cls === 'manual') return 'CLI';
    return trigger ? trigger.substring(0, 3).toUpperCase() : '?';
  }

  function formatTime(ts) {
    try {
      const d = new Date(ts);
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) + ' ' +
             d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
    } catch { return ts; }
  }

  function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
  }

  function fmtK(n) { return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }

  function formatArgPreview(args) {
    if (!args || typeof args !== 'object') return '';
    const keys = ['file_path', 'command', 'url', 'query', 'name', 'fact', 'instruction'];
    const parts = [];
    for (const k of keys) {
      if (args[k] !== undefined) {
        const v = String(args[k]);
        parts.push(k + ': ' + (v.length > 60 ? v.substring(0, 60) + '…' : v));
      }
    }
    return parts.join(' | ');
  }

  function formatJson(val) {
    if (val === undefined || val === null) return '';
    try {
      if (typeof val === 'string') {
        const parsed = JSON.parse(val);
        return JSON.stringify(parsed, null, 2);
      }
      return JSON.stringify(val, null, 2);
    } catch {
      return String(val);
    }
  }

  /**
   * Parse injected context into sections by ## headers.
   * Returns an array of {title, body} objects.
   */
  function parseContextSections(text) {
    const sections = [];
    const parts = text.split(/^(## .+)$/m);
    // parts alternates: [preamble, header1, body1, header2, body2, ...]
    if (parts[0] && parts[0].trim()) {
      sections.push({ title: 'Preamble', body: parts[0].trim() });
    }
    for (let i = 1; i < parts.length; i += 2) {
      const title = (parts[i] || '').replace(/^## /, '').trim();
      const body = (parts[i + 1] || '').trim();
      if (title) sections.push({ title: title, body: body });
    }
    // If no sections found, return the whole text as one section
    if (sections.length === 0 && text.trim()) {
      sections.push({ title: 'Full Context', body: text.trim() });
    }
    return sections;
  }

  // ── API calls ──
  function buildRunsUrl(offset) {
    const params = new URLSearchParams();
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(offset));
    const trigger = document.getElementById('trigger-filter').value;
    const session = document.getElementById('session-filter').value;
    const since = document.getElementById('since-filter').value;
    if (trigger) params.set('trigger', trigger);
    if (session) params.set('session', session);
    if (since) params.set('since', since);
    return '/api/dashboard/runs?' + params.toString();
  }

  async function loadRuns(append) {
    if (!append) {
      currentOffset = 0;
      document.getElementById('run-list').innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading runs…</div>';
    }
    try {
      const resp = await fetch(buildRunsUrl(currentOffset));
      const data = await resp.json();
      hasMore = data.hasMore;
      if (!append) {
        document.getElementById('run-list').innerHTML = '';
      } else {
        const btn = document.getElementById('load-more-btn');
        if (btn) btn.parentElement.remove();
      }
      if (data.runs.length === 0 && currentOffset === 0) {
        document.getElementById('run-list').innerHTML = '<div class="list-empty">No runs found</div>';
        return;
      }
      const list = document.getElementById('run-list');
      for (const run of data.runs) {
        list.appendChild(createRunItem(run));
      }
      currentOffset += data.runs.length;
      if (hasMore) {
        const more = document.createElement('div');
        more.className = 'load-more';
        more.innerHTML = '<button id="load-more-btn">Load more</button>';
        list.appendChild(more);
        more.querySelector('button').addEventListener('click', () => loadRuns(true));
      }
    } catch (err) {
      document.getElementById('run-list').innerHTML = '<div class="list-empty">Failed to load runs</div>';
    }
  }

  function createRunItem(run) {
    const el = document.createElement('div');
    el.className = 'run-item';
    const key = run.sessionId + '/' + run.runId;
    if (key === activeRunKey) el.classList.add('active');

    const dotClass = run.trigger === 'compaction' ? 'compacted' : run.hasError ? 'error' : (!run.heartbeatOk && triggerClass(run.trigger) === 'heartbeat') ? 'hb-fail' : 'ok';
    const tc = triggerClass(run.trigger);

    el.innerHTML =
      '<div class="run-dot ' + dotClass + '"></div>' +
      '<div class="run-info">' +
        '<div class="run-time">' + escapeHtml(formatTime(run.timestamp)) + '</div>' +
        '<div class="run-meta">' +
          '<span class="trigger-badge ' + tc + '">' + escapeHtml(triggerSymbol(run.trigger)) + '</span>' +
          (run.model ? '<span style="color:var(--cyan);font-size:0.68rem">' + escapeHtml(run.model.replace('gemini-', '').replace('-preview', '')) + '</span>' : '') +
          '<span>' + run.toolCallCount + ' tools</span>' +
          '<span>' + (run.tokens > 0 ? fmtK(run.tokens) + ' tok' : '—') + '</span>' +
          (run.inputTokens > 0 || run.outputTokens > 0 ? '<span style="font-size:0.62rem;color:var(--muted)">in:' + fmtK(run.inputTokens) + ' / out:' + fmtK(run.outputTokens) + (run.thinkingTokens > 0 ? ' / think:' + fmtK(run.thinkingTokens) : '') + '</span>' : '') +
        '</div>' +
        (run.toolNames.length > 0 ? '<div class="run-tools-preview">' + escapeHtml(run.toolNames.join(', ')) + '</div>' : '') +
        (run.errorPreview ? '<div class="run-error-preview">' + escapeHtml(run.errorPreview) + '</div>' : '') +
      '</div>';

    el.addEventListener('click', () => {
      document.querySelectorAll('.run-item.active').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      activeRunKey = key;
      loadDetail(run.sessionId, run.runId);
    });

    return el;
  }

  async function loadDetail(sessionId, runId) {
    const pane = document.getElementById('detail-pane');
    pane.classList.add('active');
    pane.innerHTML = '<div class="loading-row"><div class="spinner"></div> Loading detail…</div>';

    try {
      const resp = await fetch('/api/dashboard/runs/' + encodeURIComponent(sessionId) + '/' + encodeURIComponent(runId));
      if (!resp.ok) throw new Error('Not found');
      const entry = await resp.json();
      renderDetail(pane, entry);
    } catch {
      pane.innerHTML = '<div class="detail-placeholder">Failed to load run detail</div>';
    }
  }

  function renderDetail(pane, entry) {
    const isError = !!entry.error;
    const tc = entry.toolCalls || [];

    let html = '';

    // Summary cards
    html += '<div class="summary-grid">';
    html += '<div class="summary-card"><div class="label">Trigger</div><div class="value">' + escapeHtml(entry.trigger) + '</div></div>';
    html += '<div class="summary-card"><div class="label">Tools</div><div class="value">' + tc.length + '</div></div>';
    html += '<div class="summary-card"><div class="label">Tokens</div><div class="value">' + (entry.tokens ? fmtK(entry.tokens.total) : '—') + '</div>' +
      (entry.tokens ? '<div style="font-size:0.65rem;color:var(--muted);margin-top:2px">in: ' + fmtK(entry.tokens.input) + ' / out: ' + fmtK(entry.tokens.output) + (entry.tokens.thinking > 0 ? ' / think: ' + fmtK(entry.tokens.thinking) : '') + (entry.tokens.cached > 0 ? ' / cached: ' + fmtK(entry.tokens.cached) : '') + '</div>' : '') +
    '</div>';

    const isCompaction = entry.trigger === 'compaction';
    if (isCompaction) {
      html += '<div class="summary-card"><div class="label">Status</div><div class="value" style="color:var(--purple)">Compacted</div></div>';
    } else if (isError) {
      html += '<div class="summary-card"><div class="label">Status</div><div class="value red">Error</div></div>';
    } else if (!entry.heartbeatOk && triggerClass(entry.trigger) === 'heartbeat') {
      html += '<div class="summary-card"><div class="label">Status</div><div class="value yellow">HB Fail</div></div>';
    } else {
      html += '<div class="summary-card"><div class="label">Status</div><div class="value green">OK</div></div>';
    }
    html += '</div>';

    // Compaction Before / After section
    if (isCompaction && entry.compactionMeta) {
      const cm = entry.compactionMeta;

      // ── Before: original entries ──
      html += '<div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:20px">';
      html += '<h3 style="font-size:0.82rem;font-weight:600;color:var(--purple);margin-bottom:10px">Before — ' + cm.compactedCount + ' entries compacted</h3>';
      if (cm.rangeStart && cm.rangeEnd) {
        html += '<div style="font-size:0.72rem;color:var(--muted);margin-bottom:10px">' + escapeHtml(formatTime(cm.rangeStart)) + ' — ' + escapeHtml(formatTime(cm.rangeEnd));
        if (cm.originalTokensTotal > 0) html += ' &middot; ' + Math.round(cm.originalTokensTotal / 1000) + 'k tokens total';
        html += '</div>';
      }

      if (cm.entries && cm.entries.length > 0) {
        html += '<div style="display:flex;flex-direction:column;gap:6px">';
        for (const d of cm.entries) {
          const tCls = triggerClass(d.trigger);
          const statusColor = d.errorPreview ? 'var(--red)' : d.heartbeatOk ? 'var(--green)' : 'var(--muted)';
          const statusIcon = d.errorPreview ? '✗' : d.heartbeatOk ? '✓' : '—';

          html += '<div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:8px 12px;font-size:0.75rem">';
          // Row 1: time + trigger badge + tools + tokens + status
          html += '<div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
          html += '<span style="color:var(--text-secondary);font-family:var(--font-mono);font-size:0.7rem">' + escapeHtml(formatTime(d.timestamp)) + '</span>';
          html += '<span class="trigger-badge ' + tCls + '">' + escapeHtml(triggerSymbol(d.trigger)) + '</span>';
          html += '<span style="color:var(--muted)">' + d.toolCount + ' tools</span>';
          if (d.tokens > 0) html += '<span style="color:var(--muted)">' + fmtK(d.tokens) + ' tok</span>';
          html += '<span style="color:' + statusColor + '">' + statusIcon + '</span>';
          html += '</div>';
          // Row 2: tool names (if any)
          if (d.toolNames && d.toolNames.length > 0) {
            html += '<div style="font-size:0.68rem;color:var(--muted);margin-top:3px;font-family:var(--font-mono);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">' + escapeHtml(d.toolNames.join(', ')) + '</div>';
          }
          // Row 3: prompt/response preview
          if (d.promptPreview) {
            html += '<div style="font-size:0.7rem;color:var(--text-secondary);margin-top:4px"><span style="color:var(--muted)">Prompt:</span> ' + escapeHtml(d.promptPreview) + '</div>';
          }
          if (d.errorPreview) {
            html += '<div style="font-size:0.7rem;color:var(--red);margin-top:2px">' + escapeHtml(d.errorPreview) + '</div>';
          } else if (d.responsePreview) {
            html += '<div style="font-size:0.7rem;color:var(--text-secondary);margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis"><span style="color:var(--muted)">Response:</span> ' + escapeHtml(d.responsePreview) + '</div>';
          }
          html += '</div>';
        }
        html += '</div>';
      }
      html += '</div>';

      // ── After: summary text ──
      if (entry.responseText) {
        html += '<div style="background:var(--card);border:1px solid var(--border);border-radius:8px;padding:14px;margin-bottom:20px">';
        html += '<h3 style="font-size:0.82rem;font-weight:600;color:var(--green);margin-bottom:10px">After — Summary</h3>';
        html += '<div class="response-text">' + escapeHtml(entry.responseText) + '</div>';
        html += '</div>';
      }
    }

    // Prompt
    if (entry.prompt) {
      html += '<div class="response-section"><h3>Prompt</h3><div class="response-text">' + escapeHtml(entry.prompt) + '</div></div>';
    }

    // Injected Context — split by ## headers into individual collapsible sections
    if (entry.injectedContext) {
      const ctxLen = entry.injectedContext.length;
      const sections = parseContextSections(entry.injectedContext);
      html += '<div class="response-section"><h3>Injected Context (' + Math.round(ctxLen / 1024) + ' KB, ' + sections.length + ' sections)</h3>';
      for (const sec of sections) {
        const label = sec.title || 'Context';
        const preview = sec.body.length > 1024 ? ' (' + (sec.body.length / 1024).toFixed(1) + ' KB)' : sec.body.length > 200 ? ' (' + sec.body.length + ' chars)' : '';
        html += '<details class="tl-expand"><summary>' + escapeHtml(label) + preview + '</summary>';
        html += '<div class="tl-code" style="max-height:400px">' + escapeHtml(sec.body) + '</div>';
        html += '</details>';
      }
      html += '</div>';
    }

    // Tool call timeline
    if (tc.length > 0) {
      html += '<div class="timeline-section"><h3>Tool Calls (' + tc.length + ')</h3><div class="timeline">';
      for (const tool of tc) {
        const cat = tool.status === 'error' || tool.status === 'ERROR' ? 'error' : toolCategory(tool.name);
        const statusClass = (tool.status === 'error' || tool.status === 'ERROR') ? 'err' : 'ok';
        const statusLabel = (tool.status === 'error' || tool.status === 'ERROR') ? '✗ error' : '✓';

        html += '<div class="tl-item">';
        html += '<div class="tl-dot ' + cat + '"></div>';
        html += '<div class="tl-card">';
        html += '<div class="tl-header"><span class="tl-name">' + escapeHtml(tool.name) + '</span><span class="tl-status ' + statusClass + '">' + statusLabel + '</span></div>';

        const argPreview = formatArgPreview(tool.args);
        if (argPreview) {
          html += '<div style="font-size:0.7rem;color:var(--muted);margin-top:3px;font-family:var(--font-mono)">' + escapeHtml(argPreview) + '</div>';
        }

        const isErr = tool.status === 'error' || tool.status === 'ERROR';
        if (tool.args !== undefined && tool.args !== null) {
          html += '<details class="tl-expand"' + (isErr ? ' open' : '') + '><summary>Arguments</summary><div class="tl-code">' + escapeHtml(formatJson(tool.args)) + '</div></details>';
        }
        if (tool.result !== undefined && tool.result !== null) {
          const resultStr = String(tool.result);
          html += '<details class="tl-expand"' + (isErr ? ' open' : '') + '><summary>Result (' + resultStr.length + ' chars)</summary><div class="tl-code">' + escapeHtml(formatJson(tool.result)) + '</div></details>';
        }

        html += '</div></div>';
      }
      html += '</div></div>';
    }

    // Error
    if (entry.error) {
      html += '<div class="response-section"><h3>Error</h3><div class="response-text" style="color:var(--red)">' + escapeHtml(entry.error) + '</div></div>';
    }

    // Response text (collapsible if long) — skip for compaction (shown in After section)
    if (entry.responseText && !isCompaction) {
      const text = entry.responseText;
      html += '<div class="response-section"><h3>Response (' + text.length + ' chars)</h3>';
      if (text.length > 500) {
        html += '<details><summary style="cursor:pointer;color:var(--muted);font-size:0.78rem;margin-bottom:8px">Show response text</summary><div class="response-text">' + escapeHtml(text) + '</div></details>';
      } else {
        html += '<div class="response-text">' + escapeHtml(text) + '</div>';
      }
      html += '</div>';
    }

    pane.innerHTML = html;
  }

  // ── Session list population ──
  async function loadSessionFilter() {
    try {
      const resp = await fetch('/api/dashboard/runs/sessions');
      const sessions = await resp.json();
      const sel = document.getElementById('session-filter');
      for (const s of sessions) {
        const opt = document.createElement('option');
        opt.value = s.sessionId;
        opt.textContent = s.sessionId.substring(0, 12) + '… (' + s.runCount + ' runs)';
        sel.appendChild(opt);
      }
    } catch { /* ignore */ }
  }

  // ── Pool Status (same as Overview) ──
  async function refreshPool() {
    try {
      const data = await (await fetch('/api/dashboard/pool')).json();
      const total = data.entries.length;
      const inUse = data.entries.filter(e => e.inUse).length;
      const idle = data.entries.filter(e => !e.inUse && !e.closed).length;

      const dotsHtml = data.entries.map(e => {
        const cls = e.closed ? 'closed' : e.inUse ? 'in-use' : 'idle';
        return '<div class="pool-dot-sm ' + cls + '"></div>';
      }).join('');
      document.getElementById('pool-dots-inline').innerHTML = total > 0 ? dotsHtml : '<span style="color:var(--muted)">0</span>';

      let tip = '<div class="pool-row"><span class="pool-lbl">Max</span><span>' + data.maxSize + '</span></div>';
      tip += '<div class="pool-row"><span class="pool-lbl">Total</span><span>' + total + '</span></div>';
      tip += '<div class="pool-row"><span class="pool-lbl">In Use</span><span style="color:var(--orange)">' + inUse + '</span></div>';
      tip += '<div class="pool-row"><span class="pool-lbl">Idle</span><span style="color:var(--green)">' + idle + '</span></div>';
      if (data.waiting > 0) tip += '<div class="pool-row"><span class="pool-lbl">Waiting</span><span style="color:var(--red)">' + data.waiting + '</span></div>';
      document.getElementById('pool-tooltip').innerHTML = tip;
    } catch { /* ignore */ }
  }
  refreshPool();
  setInterval(refreshPool, 5000);

  // ── Event listeners ──
  document.getElementById('trigger-filter').addEventListener('change', () => loadRuns(false));
  document.getElementById('session-filter').addEventListener('change', () => loadRuns(false));
  document.getElementById('since-filter').addEventListener('change', () => loadRuns(false));

  // ── Init ──
  loadRuns(false);
  loadSessionFilter();
})();
</script>
</body>
</html>`;
}
