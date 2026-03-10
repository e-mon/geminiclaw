/**
 * mcp/ask-user-server.ts — MCP server exposing geminiclaw_ask_user.
 *
 * In ACP mode, tool_call notifications only arrive AFTER the tool finishes.
 * To break the deadlock, this MCP tool writes ask-user-pending-{askId}.json itself
 * so the runner can detect it via polling and post the question to chat.
 *
 * Flow:
 *   1. Model calls geminiclaw_ask_user → MCP tool starts
 *   2. MCP tool writes pending-{askId}.json with question + options
 *   3. Runner polls pending files → emits ask_user event → Discord posts question
 *   4. User answers → chat-handler writes answer-{askId}.json
 *   5. MCP tool polls answer-{askId}.json → returns answer to model
 */

import { randomUUID } from 'node:crypto';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { waitForAnswer, writePending } from '../agent/ask-user-state.js';

const TOOLS = [
    {
        name: 'geminiclaw_ask_user',
        description:
            'Ask the user a question and wait for their response. ' +
            'Use this when you need clarification, confirmation, or input from the user before proceeding. ' +
            'Pass options to show clickable buttons; omit for free-text input. ' +
            'The tool will block until the user provides an answer (up to 30 minutes).',
        inputSchema: {
            type: 'object' as const,
            properties: {
                question: {
                    type: 'string',
                    description: 'The question to ask the user',
                },
                options: {
                    type: 'array',
                    items: { type: 'string' },
                    description:
                        'Clickable button labels for the user to choose from. ' +
                        'ALWAYS provide options when possible — users strongly prefer tapping buttons over typing. ' +
                        'Only omit when the answer is truly free-form (e.g. asking for a name or URL).',
                },
            },
            required: ['question'],
        },
    },
];

export function createAskUserServer(workspace: string): Server {
    const server = new Server({ name: 'geminiclaw-ask-user', version: '0.1.0' }, { capabilities: { tools: {} } });

    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const { name, arguments: args } = request.params;

        if (name !== 'geminiclaw_ask_user') {
            return {
                content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
                isError: true,
            };
        }

        const question = String((args as Record<string, unknown>)?.question ?? '');
        if (!question.trim()) {
            return {
                content: [{ type: 'text' as const, text: 'Error: question cannot be empty' }],
                isError: true,
            };
        }

        const rawOptions = (args as Record<string, unknown>)?.options;
        const options = Array.isArray(rawOptions) ? rawOptions.map(String) : undefined;

        // Write pending question so the runner can detect it via polling
        // and post the question to Discord/Slack with buttons.
        const askId = randomUUID();
        writePending(workspace, {
            askId,
            sessionId: '*', // Wildcard — ChatProgressReporter overwrites with real sessionId
            question,
            options,
            timestamp: new Date().toISOString(),
            runId: process.env.GEMINICLAW_RUN_ID,
        });

        process.stderr.write(`[ask-user] Question: ${question}\n`);
        process.stderr.write(`[ask-user] Waiting for answer (timeout: 30 min)...\n`);

        try {
            const answer = await waitForAnswer(workspace, askId);
            process.stderr.write(`[ask-user] Got answer: ${answer.substring(0, 100)}\n`);
            return {
                content: [{ type: 'text' as const, text: `User answered: ${answer}` }],
            };
        } catch (err) {
            process.stderr.write(`[ask-user] ${String(err)}\n`);
            return {
                content: [{ type: 'text' as const, text: `Error: ${String(err)}` }],
                isError: true,
            };
        }
    });

    return server;
}

export async function startAskUserServer(workspace: string): Promise<void> {
    const server = createAskUserServer(workspace);
    const transport = new StdioServerTransport();
    await server.connect(transport);
}
