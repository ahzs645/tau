/* oxlint-disable n/prefer-global/process, unicorn/no-process-exit -- CLI tool */

/**
 * Generate CJS type declarations (.d.cts) from ESM declarations (.d.ts).
 *
 * tsdown with `unbundle: true` cannot generate CJS DTS due to a rolldown plugin conflict.
 * This script copies ESM `.d.ts` files to CJS `.d.cts` equivalents, rewriting internal
 * import specifiers from `.js` to `.cjs` so TypeScript's node16 CJS resolution works.
 *
 * Usage: tsx tools/generate-cjs-dts.ts <projectRoot>
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const projectRoot = process.argv[2];
if (!projectRoot) {
  console.error('Usage: tsx tools/generate-cjs-dts.ts <projectRoot>');
  process.exit(1);
}

const absoluteRoot = resolve(projectRoot);
const esmDirectory = join(absoluteRoot, 'dist', 'esm');
const cjsDir = join(absoluteRoot, 'dist', 'cjs');

if (!existsSync(esmDirectory)) {
  console.error(`ESM dist directory not found: ${esmDirectory}`);
  process.exit(1);
}

if (!existsSync(cjsDir)) {
  console.error(`CJS dist directory not found: ${cjsDir}`);
  process.exit(1);
}

/**
 * Rewrite relative import specifiers from `.js` to `.cjs` for CJS compatibility.
 * Handles: import ... from './foo.js', export ... from './foo.js', import('./foo.js')
 */
function rewriteImports(content: string): string {
  return content
    .replaceAll(/(from\s+['"])(\.[^'"]*?)\.js(['"])/g, '$1$2.cjs$3')
    .replaceAll(/(import\s*\(\s*['"])(\.[^'"]*?)\.js(['"]\s*\))/g, '$1$2.cjs$3');
}

let generated = 0;

function processDtsFiles(dir: string): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      processDtsFiles(fullPath);
      continue;
    }

    if (!entry.name.endsWith('.d.ts')) {
      continue;
    }

    const relativePath = fullPath.slice(esmDirectory.length);
    const ctsPath = join(cjsDir, relativePath.replace(/\.d\.ts$/, '.d.cts'));
    const ctsParentDir = ctsPath.slice(0, ctsPath.lastIndexOf('/'));

    if (!existsSync(ctsParentDir)) {
      mkdirSync(ctsParentDir, { recursive: true });
    }

    const content = readFileSync(fullPath, 'utf8');
    const rewritten = rewriteImports(content);
    writeFileSync(ctsPath, rewritten);
    generated++;
  }
}

processDtsFiles(esmDirectory);
console.log(`Generated ${generated} CJS type declaration (.d.cts) files`);
