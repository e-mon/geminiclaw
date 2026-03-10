/**
 * tui/pi/mcp-panel.ts — MCP server status overlay (Ctrl+M).
 *
 * Shows registered MCP servers from settings and tracks runtime
 * tool call statistics from StreamEvents.
 *
 *   MCP Servers  [Ctrl+M] close
 *   ─────────────────────────────
 *   geminiclaw-status     1 tool    0 calls
 *   geminiclaw-ask-user   1 tool    0 calls
 *   agent-browser         8 tools   3 calls
 *   ─────────────────────────────
 *   Total: 3 servers  10 tools  3 calls
 */

import type { Component } from '@mariozechner/pi-tui';
import chalk from 'chalk';
import type { McpServerConfig } from '../../config/gemini-settings.js';
import { padToWidth } from './format.js';
import { accent, borderDim, mutedText, toolTitle } from './theme.js';

/** Per-server runtime statistics tracked from stream events. */
interface McpServerStats {
    /** Tool names observed for this server (from tool_use events). */
    toolNames: Set<string>;
    /** Total tool calls. */
    calls: number;
    /** Successful completions. */
    successes: number;
    /** Errors. */
    errors: number;
}

/** MCP tool name prefix separator used by Gemini CLI. */
const MCP_SEPARATOR = '__';

export class McpPanelComponent implements Component {
    private servers: Map<string, McpServerConfig> = new Map();
    /** Runtime stats keyed by server name. */
    private stats: Map<string, McpServerStats> = new Map();
    /** Tool calls in-flight: toolId → server name. */
    private pendingTools: Map<string, string> = new Map();

    invalidate(): void {}

    /** Load server definitions from settings. Call when opening. */
    loadServers(mcpServers: Record<string, McpServerConfig> | undefined): void {
        this.servers.clear();
        if (!mcpServers) return;
        for (const [name, cfg] of Object.entries(mcpServers)) {
            this.servers.set(name, cfg);
        }
    }

    /** Track a tool_use event. MCP tools are prefixed: "serverName__toolName". */
    onToolUse(toolName: string, toolId: string): void {
        const serverName = this.resolveServer(toolName);
        if (!serverName) return;

        this.pendingTools.set(toolId, serverName);

        let s = this.stats.get(serverName);
        if (!s) {
            s = { toolNames: new Set(), calls: 0, successes: 0, errors: 0 };
            this.stats.set(serverName, s);
        }
        // Extract the tool part after the prefix
        const parts = toolName.split(MCP_SEPARATOR);
        const actualTool = parts.length >= 2 ? parts.slice(1).join(MCP_SEPARATOR) : toolName;
        s.toolNames.add(actualTool);
        s.calls++;
    }

    /** Track a tool_result event. */
    onToolResult(toolId: string, status: string): void {
        const serverName = this.pendingTools.get(toolId);
        if (!serverName) return;
        this.pendingTools.delete(toolId);

        const s = this.stats.get(serverName);
        if (!s) return;
        if (status === 'success') {
            s.successes++;
        } else {
            s.errors++;
        }
    }

    /** Reset runtime stats (e.g. on new turn). */
    resetStats(): void {
        this.stats.clear();
        this.pendingTools.clear();
    }

    render(width: number): string[] {
        const w = Math.max(48, width);
        const rows: string[] = [];

        // Title
        const title = `  ${toolTitle.bold('MCP Servers')}  ${mutedText('[Ctrl+M] close')}`;
        rows.push(padToWidth(title, w));
        rows.push(padToWidth(borderDim('\u2500'.repeat(w)), w));

        if (this.servers.size === 0) {
            rows.push(padToWidth(mutedText('  MCP server not configured'), w));
            rows.push(padToWidth(borderDim('\u2500'.repeat(w)), w));
            return rows;
        }

        let totalTools = 0;
        let totalCalls = 0;

        for (const [name] of this.servers) {
            const s = this.stats.get(name);
            const calls = s?.calls ?? 0;
            const errors = s?.errors ?? 0;
            const toolCount = s?.toolNames.size ?? 0;
            totalTools += toolCount;
            totalCalls += calls;

            // Status indicator
            let indicator: string;
            if (errors > 0 && calls === errors) {
                indicator = chalk.red('\u2718'); // all failed
            } else if (errors > 0) {
                indicator = chalk.yellow('\u26a0'); // some errors
            } else if (calls > 0) {
                indicator = chalk.green('\u25cf'); // active, no errors
            } else {
                indicator = chalk.dim('\u25cb'); // registered but unused
            }

            const nameCol = accent(name.padEnd(24));
            const toolsCol =
                toolCount > 0
                    ? mutedText(`${String(toolCount).padStart(2)} tool${toolCount === 1 ? ' ' : 's'}`)
                    : chalk.dim('        ');
            const callsCol =
                calls > 0
                    ? chalk.white(`${String(calls).padStart(3)} call${calls === 1 ? ' ' : 's'}`)
                    : chalk.dim('         ');
            const errCol = errors > 0 ? chalk.red(` ${errors} err`) : '';

            rows.push(padToWidth(`  ${indicator} ${nameCol} ${toolsCol}  ${callsCol}${errCol}`, w));
        }

        // Summary
        rows.push(padToWidth(borderDim('\u2500'.repeat(w)), w));
        const summary = mutedText(
            `  ${this.servers.size} server${this.servers.size === 1 ? '' : 's'}` +
                `  ${totalTools} tool${totalTools === 1 ? '' : 's'}` +
                `  ${totalCalls} call${totalCalls === 1 ? '' : 's'}`,
        );
        rows.push(padToWidth(summary, w));

        return rows;
    }

    /** Resolve a tool name to an MCP server name. */
    private resolveServer(toolName: string): string | undefined {
        // Gemini CLI qualifies MCP tools as "serverName__toolName"
        const sepIdx = toolName.indexOf(MCP_SEPARATOR);
        if (sepIdx === -1) return undefined;
        const prefix = toolName.substring(0, sepIdx);
        // Match against registered server names (with hyphens replaced by underscores,
        // since Gemini CLI normalizes server names: "geminiclaw-status" → "geminiclaw_status")
        for (const name of this.servers.keys()) {
            if (name.replace(/-/g, '_') === prefix) return name;
        }
        return undefined;
    }
}
