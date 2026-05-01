/**
 * Conformance test C10 (v6 Appendix B):
 *
 * The runner plane (`@taucad/runtime/runner` and the
 * `packages/runtime/src/runner/` directory) is fully subsumed by the
 * fat transport plugins (`@taucad/runtime/transport`). Asserts that:
 *
 * 1. The runner subpath export (`@taucad/runtime/runner`) is no longer
 *    listed in the package's `exports` map.
 * 2. The on-disk `packages/runtime/src/runner/` directory is gone.
 *
 * Future regressions (someone re-introducing a runner shim, or
 * resurrecting the `./runner` export) trip this conformance and force
 * an explicit decision rather than silent re-emergence of the deleted
 * plane.
 *
 * @see docs/research/runtime-transport-architecture-v6.md (C10 — line 2343)
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const runtimePackageRoot = join(here, '..', '..');

describe('C10 — `@taucad/runtime/runner` is removed from the public surface', () => {
  it('omits the `./runner` entry from the package exports map', () => {
    const manifestPath = join(runtimePackageRoot, 'package.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      exports?: Record<string, unknown>;
    };
    const exportPaths = Object.keys(manifest.exports ?? {});
    expect(exportPaths).not.toContain('./runner');
  });

  it('does not retain a `src/runner/` source directory', () => {
    const runnerDirectory = join(runtimePackageRoot, 'src', 'runner');
    if (existsSync(runnerDirectory)) {
      expect.fail(
        `Expected ${runnerDirectory} to be removed (subsumed by transport plugins) ` +
          `but it still contains: stat ${JSON.stringify(statSync(runnerDirectory))}`,
      );
    }
    expect(existsSync(runnerDirectory)).toBe(false);
  });
});
