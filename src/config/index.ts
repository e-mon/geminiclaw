/**
 * config/index.ts — Barrel export for the config module.
 */

export {
    type GeminiSettings,
    loadGeminiclawSettings,
    type McpServerConfig,
    saveGeminiclawSettings,
} from './gemini-settings.js';
export {
    loadConfig,
    patchConfigFile,
} from './io.js';
export {
    BROWSER_PROFILE_DIR,
    BROWSER_STATE_PATH,
    CONFIG_PATH,
    GEMINICLAW_HOME,
    GEMINICLAW_SETTINGS_PATH,
    getGeminiBin,
    getMcpDir,
    getWorkspacePath,
} from './paths.js';
export {
    type Config,
    ConfigSchema,
    type VaultConfig,
    VaultConfigSchema,
    WORKSPACE_CONFIG_FILENAME,
    type WorkspaceConfig,
    WorkspaceConfigSchema,
} from './schema.js';
