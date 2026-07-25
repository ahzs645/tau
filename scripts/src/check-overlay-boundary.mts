/**
 * Reports which files in a diff sit in upstream core rather than the fork overlay.
 *
 * Advisory only — it never fails. See docs/policy/fork-overlay-policy.md: the
 * goal is that core edits get noticed at review time and carry an upstream
 * follow-up, not that they are blocked.
 *
 *   node --import tsx scripts/src/check-overlay-boundary.mts [base-ref]
 */
import { execFileSync } from 'node:child_process';
import process from 'node:process';

const baseRef = process.argv[2] ?? 'origin/main';

/** Upstream-owned paths: edits here conflict on every sync. */
const corePrefixes = ['packages/', 'kernels/', 'libs/', 'tools/'];

/** Fork-owned paths inside otherwise-shared apps. */
const overlayPrefixes = ['apps/ui/app/routes/playground/', 'docs/research/', 'docs/policy/', '.github/workflows/'];

function changedFiles(): string[] {
  try {
    const mergeBase = execFileSync('git', ['merge-base', baseRef, 'HEAD'], { encoding: 'utf8' }).trim();
    return execFileSync('git', ['diff', '--name-only', `${mergeBase}...HEAD`], { encoding: 'utf8' })
      .split('\n')
      .filter(Boolean);
  } catch {
    console.log(`overlay-boundary: cannot diff against ${baseRef}; skipping.`);
    return [];
  }
}

const files = changedFiles();
const coreFiles = files.filter(
  (file) =>
    corePrefixes.some((prefix) => file.startsWith(prefix)) &&
    !overlayPrefixes.some((prefix) => file.startsWith(prefix)),
);

if (files.length === 0 || coreFiles.length === 0) {
  console.log(`overlay-boundary: ${files.length} changed file(s), none in upstream core. ✔`);
  process.exit(0);
}

console.log(`overlay-boundary: ${coreFiles.length} of ${files.length} changed file(s) are upstream core:\n`);
for (const file of coreFiles) {
  console.log(`  ${file}`);
}

console.log(`
Each of these should be one of:
  1. an upstreamable fix    → open the taucad/tau PR and link it in the commit body
  2. a fork-specific deviation → keep it minimal and mark it with a FORK: comment
  3. overlay work in the wrong place → move it under apps/ui/app/routes/playground/

See docs/policy/fork-overlay-policy.md.`);
