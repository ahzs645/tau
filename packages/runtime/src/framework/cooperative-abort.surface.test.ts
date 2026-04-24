// @vitest-environment node
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Surface-discipline sentinel for `cooperative-abort.ts`.
 *
 * The cooperative-abort helpers (`setAbortContext`, `clearAbortContext`,
 * `checkAbort`) are kernel-side internals that must NEVER drift onto the
 * `@taucad/runtime` public surface. End-user `RuntimeClient` consumers must
 * not be able to import these symbols — abort signalling is owned by the
 * worker dispatcher and the in-flight `RenderAbortedError` machinery.
 *
 * This test asserts:
 * 1. The file header carries `@internal`.
 * 2. Every exported function (`setAbortContext`, `clearAbortContext`,
 *    `checkAbort`) is preceded by a JSDoc block containing `@internal`.
 */

const frameworkDirectory = dirname(fileURLToPath(import.meta.url));
const sourcePath = join(frameworkDirectory, 'cooperative-abort.ts');
const lines = readFileSync(sourcePath, 'utf8').split('\n');
const fileSource = lines.join('\n');

const exportedFunctions = ['setAbortContext', 'clearAbortContext', 'checkAbort'] as const;

const internalLookbackLines = 12;
const internalPattern = /@internal\b/;

describe('cooperative-abort surface — @internal discipline', () => {
  it('should carry @internal in the file header', () => {
    const header = lines.slice(0, 30).join('\n');
    expect(header).toMatch(/@internal\b/);
  });

  for (const exportName of exportedFunctions) {
    it(`should mark \`${exportName}\` with @internal in its JSDoc block`, () => {
      const exportPattern = new RegExp(`^export\\s+function\\s+${exportName}\\b`);
      const exportLineIndex = lines.findIndex((line) => exportPattern.test(line));
      expect(
        exportLineIndex,
        `expected to find \`export function ${exportName}\` in cooperative-abort.ts`,
      ).toBeGreaterThanOrEqual(0);

      const lookbackStart = Math.max(0, exportLineIndex - internalLookbackLines);
      const lookbackWindow = lines.slice(lookbackStart, exportLineIndex).join('\n');
      expect(lookbackWindow).toMatch(internalPattern);
    });
  }

  it('should not contain the @param typo `@param param generation`', () => {
    expect(fileSource).not.toMatch(/@(?:param\s+){2}generation/);
  });
});
