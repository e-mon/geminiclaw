/**
 * agent/turn/sandbox.ts — Docker sandbox image management + legacy Seatbelt helpers.
 *
 * Docker is the primary sandbox mechanism on all platforms.
 * Seatbelt (macOS sandbox-exec) is retained as an explicit legacy option.
 */

import { execSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadGeminiclawSettings } from '../../config/gemini-settings.js';
import { GEMINICLAW_HOME } from '../../config/paths.js';
import { createLogger } from '../../logger.js';

const log = createLogger('sandbox');

export const SEATBELT_PROFILE_NAME = 'geminiclaw';

/** macOS Seatbelt profile — permissive-open base + read denials for secrets. */
const SEATBELT_PROFILE_CONTENT = `\
(version 1)

;; GeminiClaw Seatbelt profile — permissive-open base + read denials for secrets
(allow default)

;; ── Read Denials: Credentials & Keys ──────────────────────────────
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.ssh")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.gnupg")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.aws")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.azure")))
;; NOTE: ~/.config/gcloud is NOT denied — Gemini CLI needs it for Google OAuth.
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.kube")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.docker/config.json")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.oci")))

;; ── Read Denials: PaaS/Deploy ─────────────────────────────────────
(deny file-read* (literal (string-append (param "HOME_DIR") "/.netrc")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.config/heroku")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.config/vercel")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.config/netlify")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.fly")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.config/railway")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.supabase")))

;; ── Read Denials: IaC ─────────────────────────────────────────────
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.terraform.d")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.pulumi")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.vault-token")))

;; ── Read Denials: Package Manager Credentials ─────────────────────
(deny file-read* (literal (string-append (param "HOME_DIR") "/.npmrc")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.pypirc")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.gem/credentials")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.cargo/credentials.toml")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.m2/settings.xml")))

;; ── Read Denials: Git/VCS Auth ────────────────────────────────────
(deny file-read* (literal (string-append (param "HOME_DIR") "/.git-credentials")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.config/gh")))

;; ── Read Denials: AI/LLM API Keys ─────────────────────────────────
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.openai")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.anthropic")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.claude")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.claude.json")))

;; ── Read Denials: Shell History ───────────────────────────────────
(deny file-read* (literal (string-append (param "HOME_DIR") "/.zsh_history")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.bash_history")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.python_history")))
(deny file-read* (literal (string-append (param "HOME_DIR") "/.node_repl_history")))

;; ── macOS Keychain ───────────────────────────────────────────────
;; Keychain is DENIED inside sandbox. gog MCP runs on HOST via HTTP,
;; so it doesn't need sandbox Keychain access.
;; Gemini CLI's keytar probe is suppressed via GEMINI_FORCE_FILE_STORAGE=true.
(deny file-read* (with no-report) (subpath (string-append (param "HOME_DIR") "/Library/Keychains")))

;; ── Read Denials: Browser/App Auth Data ───────────────────────────
(deny file-read* (subpath (string-append (param "HOME_DIR") "/Library/Application Support/Google/Chrome")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/Library/Application Support/Firefox")))

;; ── Write Restrictions ────────────────────────────────────────────
(deny file-write*)

(allow file-write*
    (subpath (param "TARGET_DIR"))
    (subpath (param "TMP_DIR"))
    (subpath (param "CACHE_DIR"))
    ;; Agent workspace — writable for memory, sessions, etc.
    (subpath (string-append (param "HOME_DIR") "/.geminiclaw"))
    ;; ~/.gemini — Gemini CLI needs write access for sessions, telemetry, etc.
    (subpath (string-append (param "HOME_DIR") "/.gemini"))
    (subpath (string-append (param "HOME_DIR") "/.bun"))
    (subpath (string-append (param "HOME_DIR") "/.cache"))
    (subpath (string-append (param "HOME_DIR") "/.gitconfig"))
    (subpath (param "INCLUDE_DIR_0"))
    (subpath (param "INCLUDE_DIR_1"))
    (subpath (param "INCLUDE_DIR_2"))
    (subpath (param "INCLUDE_DIR_3"))
    (subpath (param "INCLUDE_DIR_4"))
    (literal "/dev/stdout")
    (literal "/dev/stderr")
    (literal "/dev/null")
    (literal "/dev/ptmx")
    (regex #"^/dev/ttys[0-9]*$")
)

;; ── Read Denials: GeminiClaw sensitive config ───────────────────────
;; vault.enc — encrypted secrets store
(deny file-read* (literal (string-append (param "HOME_DIR") "/.geminiclaw/vault.enc")))
;; config.json — contains $vault: refs and sensitive config paths
(deny file-read* (literal (string-append (param "HOME_DIR") "/.geminiclaw/config.json")))
;; settings.json — MCP server config (command paths, env vars)
(deny file-read* (literal (string-append (param "HOME_DIR") "/.geminiclaw/settings.json")))
;; browser auth state and profile
(deny file-read* (literal (string-append (param "HOME_DIR") "/.geminiclaw/browser-auth-state.json")))
(deny file-read* (subpath (string-append (param "HOME_DIR") "/.geminiclaw/browser-profile")))

;; ── Write Denials (override allows above) ─────────────────────────
;; ~/.geminiclaw/ sensitive files — agent must use admin MCP or vault CLI
(deny file-write* (literal (string-append (param "HOME_DIR") "/.geminiclaw/vault.enc")))
(deny file-write* (literal (string-append (param "HOME_DIR") "/.geminiclaw/config.json")))
(deny file-write* (literal (string-append (param "HOME_DIR") "/.geminiclaw/settings.json")))
(deny file-write* (literal (string-append (param "HOME_DIR") "/.geminiclaw/browser-auth-state.json")))
(deny file-write* (subpath (string-append (param "HOME_DIR") "/.geminiclaw/browser-profile")))
;; Workspace .gemini/settings.json — agent must not modify injected config
(deny file-write* (literal (string-append (param "TARGET_DIR") "/.gemini/settings.json")))
;; Workspace .gemini/sandbox-* — agent must not modify sandbox profiles
(deny file-write* (regex (string-append (param "TARGET_DIR") "/.gemini/sandbox-.*")))
;; .gemini/skills/ is intentionally ALLOWED — agent can create/edit custom skills
;; ~/.gemini/settings.json — global Gemini config, agent must not modify
(deny file-write* (literal (string-append (param "HOME_DIR") "/.gemini/settings.json")))
`;

/**
 * Write the Seatbelt sandbox profile to ~/.gemini/ where Gemini CLI's
 * official --sandbox flow looks for custom (non-builtin) profiles.
 * Also writes to workspace .gemini/ for backward compatibility.
 */
export function writeSeatbeltProfile(): void {
    const home = process.env.HOME ?? homedir();
    const globalGeminiDir = join(home, '.gemini');
    mkdirSync(globalGeminiDir, { recursive: true });
    writeFileSync(
        join(globalGeminiDir, `sandbox-macos-${SEATBELT_PROFILE_NAME}.sb`),
        SEATBELT_PROFILE_CONTENT,
        'utf-8',
    );
}

/**
 * Build SANDBOX_MOUNTS value for Docker sandbox.
 *
 * Gemini CLI automatically mounts the cwd into the container, so we only
 * add paths that are outside the workspace.
 *
 * Mounts:
 *   - GeminiClaw project root (dist + node_modules) — for command-based
 *     MCP servers that reference absolute host paths.
 *     Skipped when running as a bun binary ($bunfs/ paths).
 *   - ~/.geminiclaw — IPC state, workspace data
 *   - MCP server arg paths — any absolute path referenced in command-based
 *     MCP server args that isn't already covered by the above mounts.
 */
export function buildDockerSandboxMounts(cwd?: string): string {
    const resolvedCwd = cwd ? resolve(cwd) : '';
    const home = process.env.HOME ?? '';
    const coveredPrefixes: string[] = [];
    if (resolvedCwd) coveredPrefixes.push(resolvedCwd);

    const mounts: string[] = [];

    const addMount = (hostPath: string, mode: 'ro' | 'rw'): void => {
        const abs = resolve(hostPath);
        if (!existsSync(abs)) return;
        if (coveredPrefixes.some((p) => abs.startsWith(`${p}/`) || abs === p)) return;
        if (mounts.some((m) => m.startsWith(`${abs}:`))) return;
        mounts.push(`${abs}:${abs}:${mode}`);
        coveredPrefixes.push(abs);
    };

    // GeminiClaw project root — contains dist/ and node_modules/ needed
    // by command-based MCP servers. In bun binary mode import.meta.dirname
    // points to $bunfs/ which doesn't exist on disk, so the existsSync
    // check in addMount will skip it automatically.
    const projectRoot = resolve(join(import.meta.dirname ?? '.', '..', '..', '..'));
    addMount(projectRoot, 'ro');

    if (home) {
        addMount(join(home, '.geminiclaw'), 'rw');
        // Block vault.enc from being visible inside Docker — overlay with /dev/null.
        // Without this, an agent running encrypted-file backend could read the file
        // and reverse-engineer the encryption (passphrase is deterministic).
        const vaultEnc = join(home, '.geminiclaw', 'vault.enc');
        if (existsSync(vaultEnc)) {
            mounts.push(`/dev/null:${vaultEnc}:ro`);
        }
    }

    // Scan command-based MCP server args for absolute paths that need mounting.
    // This covers globally installed packages or user-configured MCP servers
    // with custom paths outside the project root.
    try {
        const settings = loadGeminiclawSettings();
        for (const cfg of Object.values(settings.mcpServers ?? {})) {
            if (!cfg.command) continue;
            for (const arg of cfg.args ?? []) {
                if (arg.startsWith('/') && existsSync(arg)) {
                    // Mount the parent directory so the file and siblings are accessible
                    const parentDir = resolve(join(arg, '..'));
                    addMount(parentDir, 'ro');
                }
            }
        }
    } catch {
        // Settings unavailable — skip MCP path scanning
    }

    return mounts.join(',');
}

// ── Docker image management ──────────────────────────────────────

let _dockerAvailable: boolean | undefined;

/** Check whether Docker CLI is available on this machine (cached for process lifetime). */
export function isDockerAvailable(): boolean {
    if (_dockerAvailable !== undefined) return _dockerAvailable;
    try {
        execSync('docker info', { stdio: 'ignore', timeout: 5_000 });
        _dockerAvailable = true;
    } catch {
        // Fallback: OrbStack's docker shim
        const orbstackDocker = join(process.env.HOME ?? '', '.orbstack', 'bin', 'docker');
        try {
            if (existsSync(orbstackDocker)) {
                execSync(`${orbstackDocker} info`, { stdio: 'ignore', timeout: 5_000 });
                _dockerAvailable = true;
            } else {
                _dockerAvailable = false;
            }
        } catch {
            _dockerAvailable = false;
        }
    }
    return _dockerAvailable;
}

const SANDBOX_IMAGE_NAME = 'geminiclaw-sandbox';
const IMAGE_HASH_FILE = join(GEMINICLAW_HOME, '.sandbox-image-hash');

/**
 * Ensure the Docker sandbox image exists and is up-to-date.
 *
 * Reads the Dockerfile from embedded templates (single source of truth)
 * and writes it to a temp file for `docker build`. Compares content hash
 * against the last-built hash to skip unnecessary rebuilds.
 */
export async function ensureSandboxImage(cwd: string): Promise<void> {
    const { getEmbeddedTemplates } = await import('../../embedded-templates.js');
    const templates = getEmbeddedTemplates();
    const content = templates['.gemini/sandbox.Dockerfile'];
    if (!content) {
        log.warn('sandbox.Dockerfile not found in embedded templates');
        return;
    }

    const currentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);

    // Check if image exists
    let imageExists = false;
    try {
        const result = execSync(`docker images -q ${SANDBOX_IMAGE_NAME}`, { encoding: 'utf-8', timeout: 10_000 });
        imageExists = result.trim().length > 0;
    } catch {
        // docker not available or error — will attempt build anyway
    }

    // Check if hash matches (image exists + hash unchanged → skip)
    if (imageExists) {
        try {
            const storedHash = existsSync(IMAGE_HASH_FILE) ? readFileSync(IMAGE_HASH_FILE, 'utf-8').trim() : '';
            if (storedHash === currentHash) {
                log.info('sandbox image up-to-date', { hash: currentHash });
                return;
            }
        } catch {
            // Can't read hash file — rebuild
        }
    }

    // Write Dockerfile to a temp location for docker build
    const tmpDockerfile = join(GEMINICLAW_HOME, 'sandbox.Dockerfile');
    mkdirSync(GEMINICLAW_HOME, { recursive: true });
    writeFileSync(tmpDockerfile, content, 'utf-8');

    log.info('building sandbox image', { image: SANDBOX_IMAGE_NAME, hash: currentHash });
    process.stderr.write(`[sandbox] Building Docker image ${SANDBOX_IMAGE_NAME}...\n`);
    try {
        execSync(`docker build -t ${SANDBOX_IMAGE_NAME} -f ${tmpDockerfile} ${cwd}`, {
            stdio: ['ignore', 'inherit', 'inherit'],
            timeout: 600_000, // 10 minutes
            env: { ...process.env, DOCKER_BUILDKIT: '1' },
        });
    } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        log.error('sandbox image build failed', { error: msg.substring(0, 500) });
        throw new Error(`Failed to build sandbox image: ${msg.substring(0, 200)}`);
    }

    // Store hash
    writeFileSync(IMAGE_HASH_FILE, currentHash, 'utf-8');
    log.info('sandbox image built successfully', { image: SANDBOX_IMAGE_NAME, hash: currentHash });
    process.stderr.write(`[sandbox] Docker image ${SANDBOX_IMAGE_NAME} built successfully.\n`);
}
