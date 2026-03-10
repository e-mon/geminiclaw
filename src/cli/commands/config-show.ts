/**
 * cli/commands/config-show.ts — Configuration management: show / get / set.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import type { Command } from 'commander';
import { CONFIG_PATH, loadConfig } from '../../config.js';

// ── Interactive selectors for known config keys ──────────────────

/** Gemini CLI model aliases and their descriptions (from google-gemini/gemini-cli). */
const MODEL_CHOICES: Array<{ value: string; label: string; hint?: string }> = [
    { value: 'auto', label: 'auto', hint: 'Auto-select based on task (= auto-gemini-3)' },
    { value: 'pro', label: 'pro', hint: 'gemini-3.1-pro-preview' },
    { value: 'flash', label: 'flash', hint: 'gemini-3-flash-preview' },
    { value: 'flash-lite', label: 'flash-lite', hint: 'gemini-2.5-flash-lite' },
    { value: 'auto-gemini-2.5', label: 'auto-gemini-2.5', hint: 'Auto-select gemini-2.5-pro/flash' },
    { value: 'gemini-2.5-pro', label: 'gemini-2.5-pro', hint: 'Gemini 2.5 Pro' },
    { value: 'gemini-2.5-flash', label: 'gemini-2.5-flash', hint: 'Gemini 2.5 Flash' },
];

/**
 * Set a value at a dot-separated key path in a nested object.
 *
 * Creates intermediate objects as needed.
 */
function setNestedValue(obj: Record<string, unknown>, key: string, value: unknown): void {
    const parts = key.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] as string;
        if (typeof current[part] !== 'object' || current[part] === null) {
            current[part] = {};
        }
        current = current[part] as Record<string, unknown>;
    }
    current[parts[parts.length - 1] as string] = value;
}

/**
 * Delete a value at a dot-separated key path from a nested object.
 */
function deleteNestedValue(obj: Record<string, unknown>, key: string): void {
    const parts = key.split('.');
    let current: Record<string, unknown> = obj;
    for (let i = 0; i < parts.length - 1; i++) {
        const part = parts[i] as string;
        if (typeof current[part] !== 'object' || current[part] === null) return;
        current = current[part] as Record<string, unknown>;
    }
    delete current[parts[parts.length - 1] as string];
}

/**
 * Get a value at a dot-separated key path from a nested object.
 */
function getNestedValue(obj: Record<string, unknown>, key: string): unknown {
    const parts = key.split('.');
    let current: unknown = obj;
    for (const part of parts) {
        if (typeof current !== 'object' || current === null) return undefined;
        current = (current as Record<string, unknown>)[part];
    }
    return current;
}

/**
 * Parse a CLI string value into the appropriate JS type.
 *
 * - `"true"` / `"false"` → boolean
 * - Numeric strings → number
 * - Everything else → string
 */
function parseValue(v: string): string | number | boolean {
    if (v === 'true') return true;
    if (v === 'false') return false;
    const num = Number(v);
    if (!Number.isNaN(num) && v.trim() !== '') return num;
    return v;
}

/**
 * Deep-clone an object, masking any keys that look like secrets.
 */
function maskSecrets(obj: unknown): unknown {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(maskSecrets);

    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
        const isSecret = /token|secret|apikey|api_key|password|credential/i.test(key);
        if (isSecret && typeof val === 'string' && val.length > 0) {
            result[key] = '***';
        } else {
            result[key] = maskSecrets(val);
        }
    }
    return result;
}

/** Load the raw config JSON from disk. */
function loadRawConfig(): Record<string, unknown> {
    if (existsSync(CONFIG_PATH)) {
        try {
            return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8')) as Record<string, unknown>;
        } catch {
            return {};
        }
    }
    return {};
}

/** Save raw config JSON to disk. */
function saveRawConfig(raw: Record<string, unknown>): void {
    const dir = CONFIG_PATH.replace(/[/\\][^/\\]+$/, '');
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
    writeFileSync(CONFIG_PATH, `${JSON.stringify(raw, null, 2)}\n`, { encoding: 'utf-8', mode: 0o600 });
}

/** Model setting slots that can be individually configured. */
const MODEL_SLOTS = [
    { key: 'model', label: 'Global', configPath: 'model' },
    { key: 'heartbeat.model', label: 'Heartbeat', configPath: 'heartbeat.model' },
    { key: 'sessionSummary.model', label: 'Session Summary', configPath: 'sessionSummary.model' },
    { key: 'offload', label: 'Offload (quota exhaustion fallback)', configPath: 'offload.model' },
] as const;

/**
 * Interactive model configuration UI.
 * Shows all model settings (global + per-feature) in a single menu,
 * allowing users to configure each one individually.
 */
async function promptModelConfig(): Promise<void> {
    const { select, isCancel } = await import('@clack/prompts');

    // Loop until user selects "done" or cancels
    while (true) {
        // Reload config each iteration to reflect changes made in previous iterations
        const config = loadConfig();
        const raw = loadRawConfig();

        const resolveCurrentModel = (slot: (typeof MODEL_SLOTS)[number]): string => {
            if (slot.key === 'model') return config.model;
            if (slot.key === 'offload') return config.offload.model;
            const value = getNestedValue(config as unknown as Record<string, unknown>, slot.key);
            return typeof value === 'string' ? value : '';
        };

        const formatSlotLabel = (slot: (typeof MODEL_SLOTS)[number]): string => {
            if (slot.key === 'offload') {
                const status = config.offload.enabled ? 'ON' : 'OFF';
                return `${slot.label}: ${status} → ${config.offload.model}`;
            }
            const current = resolveCurrentModel(slot);
            if (slot.key === 'model') return `${slot.label}: ${current}`;
            const display = current || `(global: ${config.model})`;
            return `${slot.label}: ${display}`;
        };

        const choice = await select({
            message: 'Select a model setting to configure',
            options: [
                ...MODEL_SLOTS.map((slot) => ({
                    value: slot.key,
                    label: formatSlotLabel(slot),
                })),
                { value: 'done', label: 'Done' },
            ],
        });

        if (isCancel(choice) || choice === 'done') return;

        const slot = MODEL_SLOTS.find((s) => s.key === choice);
        if (!slot) return;

        // ── Offload slot: toggle on/off + model selection ──
        if (slot.key === 'offload') {
            const offloadChoice = await select({
                message: `Offload settings (current: ${config.offload.enabled ? 'ON' : 'OFF'} → ${config.offload.model})`,
                options: [
                    {
                        value: 'toggle',
                        label: config.offload.enabled ? 'Turn OFF' : 'Turn ON',
                        hint: config.offload.enabled
                            ? 'Do not fallback on quota exhaustion'
                            : 'Auto-fallback on quota exhaustion',
                    },
                    { value: 'model', label: 'Change fallback model', hint: `current: ${config.offload.model}` },
                    { value: 'back', label: 'Back' },
                ],
            });

            if (isCancel(offloadChoice) || offloadChoice === 'back') continue;

            if (offloadChoice === 'toggle') {
                const newEnabled = !config.offload.enabled;
                setNestedValue(raw, 'offload.enabled', newEnabled);
                saveRawConfig(raw);
                process.stdout.write(`offload.enabled = ${newEnabled}\n`);
            } else if (offloadChoice === 'model') {
                const modelResult = await select({
                    message: `Select offload fallback model (current: ${config.offload.model})`,
                    options: MODEL_CHOICES.map((c) => ({
                        value: c.value,
                        label: `${c.label}${c.value === config.offload.model ? ' ✓' : ''}`,
                        hint: c.hint,
                    })),
                    initialValue: config.offload.model,
                });

                if (isCancel(modelResult)) continue;

                setNestedValue(raw, 'offload.model', modelResult as string);
                saveRawConfig(raw);
                process.stdout.write(`offload.model = ${modelResult}\n`);
            }
            continue;
        }

        // ── Standard model slot ──
        const currentValue = resolveCurrentModel(slot);
        const isOverride = slot.key !== 'model';

        const options = MODEL_CHOICES.map((c) => ({
            value: c.value,
            label: `${c.label}${c.value === currentValue ? ' ✓' : ''}`,
            hint: c.hint,
        }));

        // Per-feature slots can be cleared back to global fallback
        if (isOverride) {
            options.push({
                value: '__clear__',
                label: 'Clear override',
                hint: `Falls back to global (${config.model})`,
            });
        }

        const modelResult = await select({
            message: `Select model for ${slot.label} (current: ${currentValue || `global: ${config.model}`})`,
            options,
            initialValue: currentValue || config.model,
        });

        if (isCancel(modelResult)) continue;

        const selected = modelResult as string;
        if (selected === '__clear__') {
            deleteNestedValue(raw, slot.configPath);
        } else {
            setNestedValue(raw, slot.configPath, selected);
        }
        saveRawConfig(raw);

        const display = selected === '__clear__' ? `(cleared → global: ${config.model})` : selected;
        process.stdout.write(`${slot.configPath} = ${display}\n`);
    }
}

/** Mask a single scalar value if the key looks like a secret. */
function maskScalarSecret(key: string, value: unknown): unknown {
    const leaf = key.split('.').pop() ?? key;
    const isSecret = /token|secret|apikey|api_key|password|credential/i.test(leaf);
    if (isSecret && typeof value === 'string' && value.length > 0) return '***';
    return value;
}

export function registerConfigCommand(program: Command): void {
    const configCmd = program.command('config').description('Configuration management');

    // config show — display full configuration with secrets masked
    configCmd
        .command('show')
        .description('Show current configuration')
        .action(() => {
            const config = loadConfig();
            const masked = maskSecrets(config);
            process.stdout.write(`${JSON.stringify(masked, null, 2)}\n`);
        });

    // config get — read a single value by dot-separated key
    configCmd
        .command('get')
        .description('Get a config value by dot-separated key')
        .argument('<key>', 'Dot notation key, e.g. channels.discord.token')
        .option('--reveal', 'Show secret values unmasked')
        .action((key: string, opts: { reveal?: boolean }) => {
            const config = loadConfig();
            let value = getNestedValue(config as unknown as Record<string, unknown>, key);
            if (value === undefined) {
                process.stderr.write(`Key not found: ${key}\n`);
                process.exitCode = 1;
                return;
            }
            // Mask secret fields unless --reveal is specified
            if (!opts.reveal) {
                value = typeof value === 'object' ? maskSecrets(value) : maskScalarSecret(key, value);
            }
            const output = typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value);
            process.stdout.write(`${output}\n`);

            // Show per-component model overrides when querying "model"
            if (key === 'model') {
                if (config.heartbeat.model) {
                    process.stdout.write(`heartbeat.model = ${config.heartbeat.model}\n`);
                }
                if (config.sessionSummary.model) {
                    process.stdout.write(`sessionSummary.model = ${config.sessionSummary.model}\n`);
                }
                process.stdout.write(`offload = ${config.offload.enabled ? 'ON' : 'OFF'} → ${config.offload.model}\n`);
            }
        });

    // config set — write a single value by dot-separated key
    configCmd
        .command('set')
        .description('Set a config value by dot-separated key')
        .argument('<key>', 'Dot notation key, e.g. model, channels.discord.token')
        .argument('[value]', 'Value to set (omit for interactive selection on supported keys)')
        .action(async (key: string, rawValue: string | undefined) => {
            // Interactive selection for known keys when value is omitted
            if (rawValue === undefined) {
                if (key === 'model') {
                    await promptModelConfig();
                    return;
                } else {
                    process.stderr.write(`Error: value is required for key "${key}"\n`);
                    process.exitCode = 1;
                    return;
                }
            }

            const raw = loadRawConfig();
            setNestedValue(raw, key, parseValue(rawValue));
            saveRawConfig(raw);
            process.stdout.write(`${key} = ${rawValue}\n`);
        });
}
