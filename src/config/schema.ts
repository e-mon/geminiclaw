/**
 * config/schema.ts — Zod schemas and inferred types for GeminiClaw configuration.
 */

import { z } from 'zod';

export const VaultConfigSchema = z.object({
    /**
     * Which backend to use for secret storage.
     *   - 'auto'           : Try @napi-rs/keyring → encrypted-file (default)
     *   - 'keyring'        : OS native keychain only
     *   - 'encrypted-file' : AES-256-GCM encrypted file, machine-specific key derivation
     *   - 'command'        : Delegate to external CLI (pass, op, age, …)
     */
    backend: z.enum(['auto', 'keyring', 'encrypted-file', 'command']).default('auto'),
    /**
     * Shell command template for reading a secret (required when backend='command').
     * Use {key} as a placeholder. Example: "pass show geminiclaw/{key}"
     */
    command: z.string().optional(),
    /**
     * Shell command template for writing a secret (optional, stdin = value).
     * Example: "pass insert --force geminiclaw/{key}"
     */
    setCommand: z.string().optional(),
});

export const ConfigSchema = z.object({
    /** Whether the initial setup wizard has been completed. */
    setupCompleted: z.boolean().default(false),
    model: z.string().default('auto'),
    /**
     * Automatic model offloading when the primary model's quota is exhausted.
     * Falls back to a lighter model and recovers when quota resets.
     */
    offload: z
        .object({
            /** Enable automatic offloading. Default: true. */
            enabled: z.boolean().default(true),
            /** Fallback model to use during offload. Default: "gemini-2.5-flash". */
            model: z.string().default('gemini-2.5-flash'),
        })
        .default({}),
    workspace: z.string().default(''), // resolved at load time
    /**
     * Sandbox mode for agent execution.
     *   - true       : Auto-detect (Docker if available, disabled otherwise)
     *   - false      : Disabled
     *   - 'seatbelt' : Legacy macOS sandbox-exec (not recommended)
     *   - 'docker'   : Explicit Docker sandbox
     */
    sandbox: z.union([z.boolean(), z.enum(['seatbelt', 'docker'])]).default(true),
    /**
     * Environment variables injected into the Docker sandbox container.
     * Values support $vault: references (e.g. "$vault:github-token").
     * Useful for giving the agent access to CLI tools like gh, gcloud, etc.
     * Only effective when sandbox is 'docker' or auto-detected as Docker.
     *
     * Example: { "GH_TOKEN": "$vault:github-token", "GITHUB_TOKEN": "$vault:github-token" }
     */
    sandboxEnv: z.record(z.string(), z.string()).default({}),
    timezone: z.string().default(''), // IANA timezone, e.g. "Asia/Tokyo"; empty = system default
    /** Preferred language for agent responses (IETF tag, e.g. "en", "ja"). Default: "en". */
    language: z.string().default('en'),
    heartbeatIntervalMin: z.number().min(1).default(30),
    /** Maximum tool call iterations before SIGTERM. Prevents infinite loops. */
    maxToolIterations: z.number().min(1).default(50),
    /**
     * Minutes of inactivity before a Gemini CLI session is considered stale.
     * When fresh, --resume latest is added so Gemini inherits the native conversation history.
     * Set to 0 to disable session resumption entirely.
     */
    sessionIdleMinutes: z.number().min(0).default(60),
    /** Primary channel for the agent. Bootstrap greetings, heartbeat and cron results are sent here. */
    home: z
        .object({
            channel: z.enum(['discord', 'slack', 'telegram']),
            channelId: z.string(),
        })
        .optional(),
    /** Channel for background job notifications (heartbeat alerts, cron completion). */
    notifications: z
        .object({
            channel: z.enum(['discord', 'slack', 'telegram']),
            channelId: z.string(),
        })
        .optional(),
    /** Heartbeat-specific settings. */
    heartbeat: z
        .object({
            /**
             * Override model for heartbeat runs.
             * Heartbeat checks are lightweight — using a cheaper model (e.g. gemini-2.5-flash)
             * significantly reduces quota consumption (~31K tokens × 48 runs/day).
             * Falls back to the global `model` setting when omitted.
             */
            model: z.string().default('flash'),
            /** macOS/Linux desktop notification for heartbeat alerts. Enabled by default so alerts are never silent. */
            desktop: z.boolean().default(true),
        })
        .default({}),
    channels: z
        .object({
            discord: z
                .object({
                    token: z.string().optional(),
                    enabled: z.boolean().default(false),
                    /**
                     * Channel IDs where the bot responds to all messages without requiring @mention.
                     * home channel is automatically included at runtime — no need to list it here.
                     * Can be updated by the agent via {workspace}/config.json.
                     */
                    respondInChannels: z.array(z.string()).default([]),
                })
                .default({}),
            telegram: z
                .object({
                    botToken: z.string().optional(),
                    enabled: z.boolean().default(false),
                    mode: z.enum(['auto', 'webhook', 'polling']).default('auto'),
                    /**
                     * Chat IDs where the bot responds to all messages without requiring @mention.
                     * home.channelId is automatically included at runtime when home.channel is 'telegram'.
                     * Can be updated by the agent via {workspace}/config.json.
                     */
                    respondInChannels: z.array(z.string()).default([]),
                })
                .default({}),
            slack: z
                .object({
                    token: z.string().optional(),
                    signingSecret: z.string().optional(),
                    enabled: z.boolean().default(false),
                    /**
                     * Channel IDs where the bot responds to all messages without requiring @mention.
                     * home channel is automatically included at runtime — no need to list it here.
                     * Can be updated by the agent via {workspace}/config.json.
                     */
                    respondInChannels: z.array(z.string()).default([]),
                })
                .default({}),
        })
        .default({}),
    /** HTTP server port for serve.ts (default: 3000). */
    port: z.number().optional(),
    /** Google account for gog CLI (e.g. "user@gmail.com"). Used as --account default. */
    gogAccount: z.string().optional(),
    /** Memory search configuration (QMD). */
    memory: z.object({}).default({}),
    /** Vault configuration for secure secret storage. */
    vault: VaultConfigSchema.default({}),
    /**
     * Agent autonomy level. Controls how freely the agent takes actions.
     *   - 'autonomous'  — all operations proceed automatically (default)
     *   - 'supervised'  — agent must confirm irreversible actions with the user
     *   - 'read_only'   — only reads and searches are permitted; no writes or shell
     *
     * Soft enforcement via GEMINI.md instructions.
     */
    autonomyLevel: z.enum(['autonomous', 'supervised', 'read_only']).default('autonomous'),
    /**
     * Cron job settings.
     */
    /**
     * Token budget settings for the `-p` prompt injection.
     * Controls how much of the context window is allocated to each section.
     */
    promptBudget: z
        .object({
            /** Max tokens for session history (compacted). Default: 4000. */
            sessionHistory: z.number().min(0).default(4000),
        })
        .default({}),
    /** Preview server settings for sharing HTML/images via Tailscale. */
    preview: z
        .object({
            /** Enable the preview server and tailscale serve integration. */
            enabled: z.boolean().default(true),
            /** Port for the isolated preview server. Defaults to main port + 1. */
            port: z.number().min(1).max(65535).optional(),
            /** Hours after which old preview files are cleaned up. 0 = disabled. */
            cleanupHours: z.number().min(0).default(72),
        })
        .default({}),
    /** Experimental features. */
    experimental: z
        .object({
            /**
             * Inject recent channel messages and thread summaries into the agent context.
             * Set maxDays > 0 to enable. Messages older than maxDays are excluded.
             * Set maxDays = 0 to disable (default).
             */
            channelContext: z
                .object({
                    /** Include messages from the last N days. 0 = disabled. */
                    maxDays: z.number().min(0).default(0),
                    /** Max messages to fetch from the platform API per call. */
                    maxMessages: z.number().min(1).max(100).default(50),
                    /** Max characters for the rendered channel context block. Oldest messages are trimmed first. */
                    maxChars: z.number().min(100).default(6000),
                })
                .default({}),
        })
        .default({}),
    /** Session summary generation settings. */
    sessionSummary: z
        .object({
            /**
             * Override model for summary generation.
             * Summaries are lightweight — a cheaper model (e.g. gemini-2.5-flash-lite)
             * is usually sufficient. Falls back to the global `model` setting when omitted.
             */
            model: z.string().default('flash'),
            /** Custom Handlebars-style template file path. */
            template: z.string().optional(),
        })
        .default({}),
    cron: z
        .object({
            /**
             * Hours after which completed cron session JSONL files are auto-pruned.
             * 0 = disabled (keep forever). Default: 72 (3 days).
             */
            sessionRetentionHours: z.number().min(0).default(72),
        })
        .default({}),
});

export type Config = z.infer<typeof ConfigSchema>;
export type VaultConfig = z.infer<typeof VaultConfigSchema>;

/**
 * Behavioral settings that the agent can self-modify by writing to
 * {workspace}/config.json. Secrets (tokens, API keys) are intentionally
 * excluded — those stay in ~/.geminiclaw/config.json only.
 *
 * All fields are optional; only present keys override global config.
 */
export const WorkspaceConfigSchema = z.object({
    autonomyLevel: z.enum(['autonomous', 'supervised', 'read_only']).optional(),
    heartbeatIntervalMin: z.number().min(1).optional(),
    maxToolIterations: z.number().min(1).optional(),
    sessionIdleMinutes: z.number().min(0).optional(),
    discord: z
        .object({
            /** Channel IDs where the bot responds without @mention. */
            respondInChannels: z.array(z.string()).optional(),
        })
        .optional(),
    slack: z
        .object({
            /** Channel IDs where the bot responds without @mention. */
            respondInChannels: z.array(z.string()).optional(),
        })
        .optional(),
    telegram: z
        .object({
            /** Chat IDs where the bot responds without @mention. */
            respondInChannels: z.array(z.string()).optional(),
        })
        .optional(),
});

export type WorkspaceConfig = z.infer<typeof WorkspaceConfigSchema>;

/** Filename for the agent-writable config inside the workspace directory. */
export const WORKSPACE_CONFIG_FILENAME = 'config.json';
