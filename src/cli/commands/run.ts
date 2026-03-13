/**
 * cli/commands/run.ts — Run agent with a prompt or in interactive mode.
 */

import { copyFileSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { Command } from 'commander';
import type { InputFile } from '../../agent/turn/index.js';
import { runAgentTurn } from '../../agent/turn/index.js';
import { getWorkspacePath, loadConfig } from '../../config.js';

/**
 * Copy local files into the workspace attachments directory for Gemini CLI access.
 * Returns InputFile[] or undefined if no files specified.
 */
function copyFilesToWorkspace(
    filePaths: string[] | undefined,
    workspacePath: string,
    sessionId: string,
): InputFile[] | undefined {
    if (!filePaths?.length) return undefined;

    const attachDir = join(workspacePath, 'runs', sessionId, 'attachments');
    mkdirSync(attachDir, { recursive: true });

    return filePaths.map((filePath) => {
        const abs = resolve(filePath);
        if (!existsSync(abs)) {
            throw new Error(`File not found: ${filePath}`);
        }
        const name = basename(abs);
        const safeName = `${Date.now()}-${name}`;
        const dest = join(attachDir, safeName);
        copyFileSync(abs, dest);
        return { path: `runs/${sessionId}/attachments/${safeName}`, originalName: name };
    });
}

function isProcessRunning(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch {
        return false;
    }
}

export function registerRunCommand(program: Command): void {
    program
        .command('run')
        .description('Run agent with a prompt (omit prompt for interactive mode)')
        .argument('[prompt]', 'The prompt to send to the agent')
        .option('--session <id>', 'Continue a previous session')
        .option('-m, --model <model>', 'Model to use')
        .option('--autonomy <level>', 'Override autonomy level (autonomous|supervised|read_only)')
        .option('-f, --file <paths...>', 'Files to include as multimodal input (images etc.)')
        .option('--async', 'Fire as Inngest event (non-blocking, queued)')
        .option('--no-tui', 'Disable rich TUI and use plain text output')
        .action(async (prompt: string | undefined, options) => {
            const config = loadConfig();
            const workspacePath = getWorkspacePath(config);
            const model = options.model ?? config.model;

            // Async mode: fire Inngest event and exit
            if (options.async) {
                const { inngest } = await import('../../inngest/client.js');
                const sessionId = options.session ?? `manual-${Date.now()}`;
                const files = copyFilesToWorkspace(options.file as string[] | undefined, workspacePath, sessionId);
                await inngest.send({
                    name: 'geminiclaw/run',
                    data: { sessionId, trigger: 'manual', prompt, model, ...(files ? { files } : {}) },
                });
                return;
            }

            // Synchronous mode: direct execution with workspace lock
            const lockFile = join(workspacePath, '.geminiclaw.lock');
            if (existsSync(lockFile)) {
                try {
                    const lockContent = readFileSync(lockFile, 'utf-8');
                    const pid = parseInt(lockContent.split('\n')[0], 10);
                    if (pid && !isProcessRunning(pid)) {
                        unlinkSync(lockFile); // stale lock
                    } else {
                        process.stderr.write(
                            `Error: another geminiclaw instance is running (PID ${pid}).\n` +
                                `  Use --async to queue via Inngest, or run \`kill ${pid}\` to stop it.\n`,
                        );
                        process.exit(1);
                    }
                } catch {
                    try {
                        unlinkSync(lockFile);
                    } catch {}
                }
            }

            writeFileSync(lockFile, `${process.pid}\n${new Date().toISOString()}\n`);
            const cleanup = () => {
                try {
                    unlinkSync(lockFile);
                } catch {}
            };
            process.on('exit', cleanup);
            process.on('SIGINT', () => {
                cleanup();
                process.exit(130);
            });

            const sessionId = options.session ?? `manual-${Date.now()}`;

            const inputFiles = copyFilesToWorkspace(options.file as string[] | undefined, workspacePath, sessionId);

            const turnParams = {
                sessionId,
                trigger: 'manual' as const,
                workspacePath,
                model,
                timezone: config.timezone || undefined,
                autonomyLevel: options.autonomy ?? config.autonomyLevel,
                maxToolIterations: config.maxToolIterations,
                files: inputFiles,
                sandbox: config.sandbox,
            };

            try {
                const useTui = process.stdout.isTTY === true && options.tui !== false;
                const useInteractive = useTui && !prompt;

                if (useInteractive && !config.setupCompleted) {
                    process.stderr.write('Initial setup is not complete. Starting setup...\n');
                    const { runSetupWizard } = await import('./setup.js');
                    await runSetupWizard(config, workspacePath);
                }

                if (useInteractive) {
                    const { EventEmitter } = await import('node:events');
                    const { startInteractiveTui } = await import('../../tui/interactive.js');

                    const emitter = new EventEmitter();
                    // Files from --file are only used for the first turn
                    let pendingFiles = turnParams.files;

                    const onUserMessage = (userPrompt: string): void => {
                        const filesForThisTurn = pendingFiles;
                        pendingFiles = undefined;
                        void (async () => {
                            emitter.emit('turn-start', userPrompt);
                            try {
                                const result = await runAgentTurn({
                                    ...turnParams,
                                    files: filesForThisTurn,
                                    prompt: userPrompt,
                                    onEvent: (e) => emitter.emit('event', e),
                                });
                                emitter.emit('turn-done', result);
                            } catch (err) {
                                emitter.emit('event', {
                                    type: 'error',
                                    severity: 'error',
                                    message: err instanceof Error ? err.message : String(err),
                                    timestamp: new Date().toISOString(),
                                });
                                emitter.emit('turn-error', err instanceof Error ? err : new Error(String(err)));
                            }
                        })();
                    };

                    const tui = await startInteractiveTui({
                        emitter,
                        defaultModel: model,
                        sessionId,
                        trigger: 'manual',
                        workspacePath,
                        onUserMessage,
                    });

                    await tui.waitUntilExit();
                } else if (useTui && prompt) {
                    const { EventEmitter } = await import('node:events');
                    const { startTui } = await import('../../tui/index.js');

                    const emitter = new EventEmitter();
                    const tui = await startTui({
                        emitter,
                        prompt,
                        defaultModel: model,
                        trigger: 'manual',
                    });

                    try {
                        const result = await runAgentTurn({
                            ...turnParams,
                            prompt,
                            onEvent: (e) => emitter.emit('event', e),
                        });
                        emitter.emit('done', result);
                    } catch (err) {
                        emitter.emit('event', {
                            type: 'error',
                            severity: 'error',
                            message: err instanceof Error ? err.message : String(err),
                            timestamp: new Date().toISOString(),
                        });
                    }

                    await tui.waitUntilExit();
                } else {
                    if (!prompt) {
                        process.stderr.write('Error: prompt required when not running in a TTY\n');
                        process.exitCode = 1;
                        return;
                    }

                    const { createThinkFilterState, processThinkDelta, flushThinkBuffer } = await import(
                        '../../tui/utils/think-filter.js'
                    );

                    let thinkState = createThinkFilterState();
                    let streamed = false;

                    const result = await runAgentTurn({
                        ...turnParams,
                        prompt,
                        onEvent: (event) => {
                            if (event.type === 'message' && event.role === 'assistant') {
                                const rawDelta = typeof event.delta === 'string' ? event.delta : null;
                                const raw = rawDelta ?? (typeof event.content === 'string' ? event.content : '');
                                if (raw) {
                                    const { flushed, nextState } = processThinkDelta(thinkState, raw);
                                    thinkState = nextState;
                                    if (flushed) {
                                        process.stdout.write(flushed);
                                        streamed = true;
                                    }
                                }
                            }
                        },
                    });

                    const { text: tail } = flushThinkBuffer(thinkState);
                    if (tail) {
                        process.stdout.write(tail);
                        streamed = true;
                    }
                    if (!streamed && result.responseText) {
                        process.stdout.write(result.responseText);
                    } else if (!streamed && result.error) {
                        process.stderr.write(`Error: ${result.error}\n`);
                    }
                    process.stdout.write('\n');
                }
            } finally {
                cleanup();
            }
        });
}
