/**
 * Keep upstream jobs restricted to the upstream repository after future merges.
 *
 * Usage: pnpm nx run scripts:validate-fork-workflows
 * Environment: none. Exit 0 means all jobs are guarded; exit 1 reports violations.
 * This checks committed workflow structure, not hosted repository permissions.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import process from 'node:process';
import { pathToFileURL } from 'node:url';
import { load } from 'js-yaml';

type WorkflowFile = { readonly name: string; readonly text: string };

const forkWorkflows = new Set(['gallery-checks.yml', 'github-pages.yml', 'upstream-drift.yml']);
const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** The optional original condition must stay wholly inside the guard's AND operand. */
const isBalancedOperand = (expression: string): boolean => {
  let depth = 0;
  let quoted = false;
  for (let index = 0; index < expression.length; index += 1) {
    const character = expression[index];
    if (character === "'") {
      if (quoted && expression[index + 1] === "'") {
        index += 1;
      } else {
        quoted = !quoted;
      }
      continue;
    }
    if (quoted) {
      continue;
    }
    switch (character) {
      case '(': {
        depth += 1;
        break;
      }
      case ')': {
        depth -= 1;
        if (depth < 0) {
          return false;
        }
        break;
      }
      case '{':
      case '}': {
        return false;
      }
      default: {
        break;
      }
    }
  }
  return depth === 0 && !quoted && expression.trim().length > 0;
};

/** Accept the canonical guard, optionally ANDed with one parenthesized original condition. */
export const hasUpstreamRepositoryGuard = (condition: unknown): boolean => {
  if (typeof condition !== 'string') {
    return false;
  }
  const match = /^\s*\$\{\{\s*github\.repository\s*==\s*'taucad\/tau'\s*(?:&&\s*\(([\s\S]*)\)\s*)?\}\}\s*$/u.exec(
    condition,
  );
  return match !== null && (match[1] === undefined || isBalancedOperand(match[1]));
};

/** Reject absent guards, step-only guards, and OR expressions that escape the guard. */
export const validateForkWorkflows = (
  files: readonly WorkflowFile[],
): { readonly violations: string[]; readonly workflows: number; readonly jobs: number } => {
  const violations: string[] = [];
  let workflows = 0;
  let jobs = 0;
  for (const file of files) {
    if (forkWorkflows.has(file.name)) {
      continue;
    }
    workflows += 1;
    try {
      const document: unknown = load(file.text);
      if (!isRecord(document) || !isRecord(document['jobs']) || Object.keys(document['jobs']).length === 0) {
        violations.push(`${file.name}: no workflow jobs were found`);
        continue;
      }
      for (const [name, job] of Object.entries(document['jobs'])) {
        jobs += 1;
        if (!isRecord(job) || !hasUpstreamRepositoryGuard(job['if'])) {
          violations.push(`${file.name} (${name}): missing canonical upstream repository guard`);
        }
      }
    } catch (error) {
      violations.push(`${file.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (workflows === 0 || jobs === 0) {
    violations.push('No upstream workflow jobs were checked');
  }
  return { violations, workflows, jobs };
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const directory = resolve(import.meta.dirname, '../../.github/workflows');
    const files = readdirSync(directory)
      .filter((name) => /\.ya?ml$/u.test(name))
      .map((name) => ({ name, text: readFileSync(resolve(directory, name), 'utf8') }));
    const result = validateForkWorkflows(files);
    if (result.violations.length > 0) {
      console.error(result.violations.join('\n'));
      process.exit(1);
    }
    console.log(`Validated ${result.jobs} upstream jobs in ${result.workflows} workflows.`);
  } catch (error) {
    console.error('Fork workflow validation failed:', error);
    process.exit(1);
  }
}
