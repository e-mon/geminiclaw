/**
 * types.ts — スキルシステムのコア型定義。
 *
 * スキルのフロントマター・セキュリティスキャン結果を表す型を定義する。
 */

export interface SkillFrontmatter {
    name: string;
    description: string;
    enabled: boolean;
    source?: 'bundled' | 'installed' | 'external';
    /** インストール日時 (ISO 8601) */
    installedAt?: string;
    /** 'openclaw/jdrhyne/todo-tracker@1.0.0' 形式の参照 */
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
    /** 決定論的静的パターンのみで決定されるリスクレベル */
    riskLevel: RiskLevel;
    findings: SecurityFinding[];
    /** LLM による補助的セキュリティ分析（advisory のみ、riskLevel を変更しない） */
    llmAdvisory?: string;
    scannedAt: string;
}
