import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * R5 (audit) — boundary discipline sentinel for the runtime client surface.
 *
 * Scans the runtime-client public surface files for `as unknown as` casts and
 * asserts each one is preceded within 5 lines above by a `// SAFETY:` comment
 * block. This catches drive-by escape hatches at PR-review time — a layer
 * type-check cannot enforce, since the cast itself is type-system-legal.
 *
 * Currently the surface contains zero `as unknown as` casts (narrowing at the
 * worker seam is achieved via overload signatures). The test exists to prevent
 * future drive-by additions from being merged without explicit safety
 * justification.
 *
 * See `docs/research/runtime-client-type-preservation-audit.md` (R5).
 */

const clientDirectory = dirname(fileURLToPath(import.meta.url));
const surfaceFiles = ['runtime-client.ts', 'runtime-client-options.ts'] as const;
const safetyLookbackLines = 5;
const castPattern = /\bas\s+unknown\s+as\b/;
const safetyPattern = /\/\/\s*SAFETY\b/;

describe('runtime client surface — cast discipline (audit-R5)', () => {
  for (const filename of surfaceFiles) {
    it(`should bound every \`as unknown as\` cast in ${filename} with a // SAFETY: block within ${safetyLookbackLines} lines above`, () => {
      const lines = readFileSync(join(clientDirectory, filename), 'utf8').split('\n');
      const violations: string[] = [];

      for (const [index, line] of lines.entries()) {
        if (!castPattern.test(line)) {
          continue;
        }
        const lookbackStart = Math.max(0, index - safetyLookbackLines);
        const lookbackWindow = lines.slice(lookbackStart, index).join('\n');
        if (safetyPattern.test(lookbackWindow)) {
          continue;
        }
        violations.push(`${filename}:${index + 1}  ${line.trim()}`);
      }

      expect(violations).toEqual([]);
    });
  }
});
