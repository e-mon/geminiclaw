/**
 * mcp/gog-server.ts — MCP server wrapping the gog CLI.
 *
 * Runs on the host (not inside sandbox), so Keychain access works.
 * If gog is not installed, ListTools returns an empty array (graceful degradation).
 */

import { execFile } from 'node:child_process';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { auditLog } from './audit.js';
import { GOG_TOOLS, GOG_TOOLS_MAP } from './gog-tools.js';
import { confirmIfNeeded, toAnnotations } from './tool-effect.js';

const EXEC_TIMEOUT_MS = 30_000;

/** Server-side hard caps — agent-provided `max` is clamped to these values. */
const MAX_RESULTS_CAP: Record<string, number> = {
    gog_gmail_search: 50,
    gog_gmail_messages_search: 50,
    gog_calendar_events: 100,
    gog_contacts_list: 50,
    gog_drive_search: 50,
};

/** Clamp the `max` param to the hard cap for this tool. */
function clampMaxResults(toolName: string, params: Record<string, unknown>): void {
    const cap = MAX_RESULTS_CAP[toolName];
    if (cap === undefined) return;
    const requested = typeof params.max === 'number' ? params.max : cap;
    params.max = Math.min(Math.max(1, requested), cap);
}

function execGog(gogPath: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
        execFile(gogPath, args, { timeout: EXEC_TIMEOUT_MS }, (err, stdout, stderr) => {
            if (err) {
                const msg = stderr?.trim() || err.message;
                reject(new Error(msg));
            } else {
                resolve(stdout);
            }
        });
    });
}

/** Fetch Gmail thread snippet for confirmation context. Returns empty string on failure. */
async function fetchThreadSnippet(gogPath: string, threadId: string, account: string | undefined): Promise<string> {
    try {
        const args = [
            'gmail',
            'thread',
            'get',
            threadId,
            '--json',
            '--no-input',
            ...(account ? ['--account', account] : []),
        ];
        const output = await execGog(gogPath, args);
        const data = JSON.parse(output);
        const msgs = data.thread?.messages ?? data.messages ?? [];
        const headers: { name: string; value: string }[] = msgs[0]?.payload?.headers ?? [];
        const hdr = (name: string): string => headers.find((h) => h.name === name)?.value ?? '';
        const from = hdr('From');
        const subject = hdr('Subject');
        if (from || subject) {
            return `"${subject}" from ${from}`;
        }
    } catch {
        // Best-effort: fall through to empty string
    }
    return '';
}

/** Build a human-readable description for confirmation prompts. */
async function describeOperation(
    toolName: string,
    params: Record<string, unknown>,
    gogPath: string,
    account: string | undefined,
): Promise<string> {
    const parts = [toolName];
    if (params.to) parts.push(`To: ${params.to}`);
    if (params.cc) parts.push(`CC: ${params.cc}`);
    if (params.bcc) parts.push(`BCC: ${params.bcc}`);
    if (params.subject) parts.push(`Subject: ${params.subject}`);
    if (params.draftId) parts.push(`Draft: ${params.draftId}`);
    if (params.threadId) {
        const snippet = await fetchThreadSnippet(gogPath, String(params.threadId), account);
        parts.push(snippet || `Thread: ${params.threadId}`);
    }
    if (params.add) parts.push(`+Label: ${params.add}`);
    if (params.remove) parts.push(`-Label: ${params.remove}`);
    // Show body preview so user knows what's being sent
    const body = params.bodyHtml ?? params.body;
    if (typeof body === 'string' && body.length > 0) {
        const preview = body.length > 200 ? `${body.substring(0, 200)}…` : body;
        parts.push(`Body: ${preview}`);
    }
    return parts.join(' | ');
}

export function createGogServer(workspace: string, gogPath: string | null, account?: string): Server {
    const server = new Server({ name: 'geminiclaw-google', version: '0.1.0' }, { capabilities: { tools: {} } });

    // Build MCP tool list from definitions (only if gog is installed)
    const mcpTools = gogPath
        ? GOG_TOOLS.map((t) => ({
              name: t.name,
              description: t.description,
              inputSchema: t.inputSchema,
              annotations: toAnnotations(t.effect),
          }))
        : [];

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: mcpTools }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;
        const params = (args ?? {}) as Record<string, unknown>;
        const toolDef = GOG_TOOLS_MAP.get(name);

        if (!toolDef || !gogPath) {
            return {
                content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }

        const start = Date.now();
        try {
            // Enforce server-side maxResults cap before building args
            clampMaxResults(name, params);

            // Gate elevated/destructive behind user confirmation (autonomy-level escalation is automatic).
            const desc = await describeOperation(name, params, gogPath, account);
            await confirmIfNeeded(workspace, toolDef.effect, desc);

            // Build full argument list
            const cliArgs = [
                ...toolDef.command,
                ...toolDef.buildArgs(params),
                '--json',
                '--no-input',
                ...(account ? ['--account', account] : []),
            ];

            const output = await execGog(gogPath, cliArgs);

            const outputLines = output.split('\n').length;
            auditLog(workspace, {
                ts: new Date().toISOString(),
                tool: name,
                effect: toolDef.effect,
                params,
                ok: true,
                ms: Date.now() - start,
                resultLines: outputLines,
            });

            return { content: [{ type: 'text' as const, text: output }] };
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            auditLog(workspace, {
                ts: new Date().toISOString(),
                tool: name,
                effect: toolDef.effect,
                params,
                ok: false,
                ms: Date.now() - start,
            });

            return {
                content: [{ type: 'text' as const, text: `Error: ${message}` }],
                isError: true,
            };
        }
    });

    return server;
}

export async function startGogServer(workspace: string, gogPath: string | null, account?: string): Promise<void> {
    const server = createGogServer(workspace, gogPath, account);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
