/**
 * types.ts — Core type definitions for the skill system.
 *
 * Defines types for skill frontmatter and security scan results.
 */

export interface SkillFrontmatter {
    name: string;
    description: string;
    enabled: boolean;
    source?: 'bundled' | 'installed' | 'external';
    /** Installation date (ISO 8601) */
    installedAt?: string;
    /** Reference in 'openclaw/jdrhyne/todo-tracker@1.0.0' format */
    sourceRef?: string;
}

export type RiskLevel = 'safe' | 'warning' | 'danger';

export interface SecurityFinding {
    file: string;
    line: number;
    pattern: string;
    description: string;
    severity: RiskLevel;
}

export interface SecurityReport {
    /** Risk level determined solely by deterministic static patterns */
    riskLevel: RiskLevel;
    findings: SecurityFinding[];
    /** LLM-assisted supplementary security analysis (advisory only, does not change riskLevel) */
    llmAdvisory?: string;
    scannedAt: string;
}
