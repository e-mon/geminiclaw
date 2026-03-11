/**
 * embed-templates.ts — Generate src/embedded-templates.ts from templates/ directory.
 *
 * Usage:
 *   bun scripts/embed-templates.ts          → dev mode (readFileSync at runtime)
 *   bun scripts/embed-templates.ts --bun    → bundle mode (inline content as strings)
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname ?? '.', '..');
const TEMPLATES_DIR = join(ROOT, 'templates');
const OUTPUT = join(ROOT, 'src', 'embedded-templates.ts');
const BUNDLE_MODE = process.argv.includes('--bun');

function walkDir(dir: string): string[] {
  const entries: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      entries.push(...walkDir(full));
    } else {
      entries.push(full);
    }
  }
  return entries.sort();
}

// BOOTSTRAP.md is handled separately in Workspace.create() (first-init only).
// Exclude it from embedded templates to prevent re-creation on every init.
const EXCLUDED = new Set(['BOOTSTRAP.md']);

const files = walkDir(TEMPLATES_DIR);
const relPaths = files.map((f) => relative(TEMPLATES_DIR, f)).filter((rel) => !EXCLUDED.has(rel));

if (BUNDLE_MODE) {
  // Inline all template contents as string literals for single-binary builds
  const entries = relPaths.map((rel) => {
    const content = readFileSync(join(TEMPLATES_DIR, rel), 'utf-8');
    const escaped = JSON.stringify(content);
    return `    ${JSON.stringify(rel)}: ${escaped}`;
  });

  const code = `/**
 * embedded-templates.ts — Auto-generated (bundle mode)
 * DO NOT EDIT. Re-generate with: bun scripts/embed-templates.ts --bun
 */

// biome-ignore format: auto-generated
const TEMPLATES: Record<string, string> = {
${entries.join(',\n')}
};

export function getEmbeddedTemplates(): Record<string, string> {
    return TEMPLATES;
}
`;
  writeFileSync(OUTPUT, code, 'utf-8');
} else {
  // Dev mode: resolve paths at runtime via readFileSync
  const entries = relPaths.map((rel) => {
    return `    ${JSON.stringify(rel)}: resolve(__dirname, ${JSON.stringify(`../templates/${rel}`)})`;
  });

  const code = `/**
 * embedded-templates.ts — Auto-generated (dev mode)
 * DO NOT EDIT. Re-generate with: bun scripts/embed-templates.ts
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const __dirname = import.meta.dirname ?? '.';

// biome-ignore format: auto-generated
const TEMPLATE_PATHS: Record<string, string> = {
${entries.join(',\n')}
};

let cached: Record<string, string> | undefined;

export function getEmbeddedTemplates(): Record<string, string> {
    if (cached) return cached;
    cached = {};
    for (const [relPath, filePath] of Object.entries(TEMPLATE_PATHS)) {
        cached[relPath] = readFileSync(filePath, 'utf-8');
    }
    return cached;
}
`;
  writeFileSync(OUTPUT, code, 'utf-8');
}

console.log(
  `embed-templates: wrote ${relPaths.length} templates (${BUNDLE_MODE ? 'bundle' : 'dev'} mode) → src/embedded-templates.ts`,
);
