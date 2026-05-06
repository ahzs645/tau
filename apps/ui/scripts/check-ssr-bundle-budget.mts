/**
 * Fails the target when SSR output exceeds byte budgets.
 *
 * Ratchet: lower `ssrBundleByteBudget` / `ssrIndexFileByteBudget` as the bundle
 * shrinks (see docs/research/ssr-bundle-audit.md).
 */
import { execSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

/** `du -sk build/server` total; ~10.1 MiB observed after maps off + workspace `ssr.external`. */
const ssrBundleByteBudget = 11 * 1024 * 1024;

/** Main SSR entry file — cap cold-parse surface even when code splits into `assets/`. */
const ssrIndexFileByteBudget = 3 * 1024 * 1024;

const scriptDirectory = fileURLToPath(new URL('.', import.meta.url));
const serverDirectory = join(scriptDirectory, '..', 'build', 'server');
const indexPath = join(serverDirectory, 'index.js');

const sizeStdout = execSync(`du -sk ${serverDirectory}`, { encoding: 'utf8' }).trim();
const sizeKib = Number(sizeStdout.split(/\s+/)[0]);
if (Number.isNaN(sizeKib)) {
  console.error('check-ssr-bundle-budget: could not parse du output:', sizeStdout);
  process.exit(1);
}

const directoryBytes = sizeKib * 1024;
if (directoryBytes > ssrBundleByteBudget) {
  console.error(
    `SSR bundle too large: ${directoryBytes} bytes (du -sk rounded) exceeds budget ${ssrBundleByteBudget} bytes`,
  );
  process.exit(1);
}

let indexBytes: number;
try {
  indexBytes = statSync(indexPath).size;
} catch (error) {
  console.error('check-ssr-bundle-budget: missing', indexPath, error);
  process.exit(1);
}

if (indexBytes > ssrIndexFileByteBudget) {
  console.error(`SSR index.js too large: ${indexBytes} bytes exceeds budget ${ssrIndexFileByteBudget} bytes`);
  process.exit(1);
}

console.info(
  `SSR bundle budget OK: ~${directoryBytes} bytes (server dir) <= ${ssrBundleByteBudget}; index.js ${indexBytes} bytes <= ${ssrIndexFileByteBudget}`,
);
