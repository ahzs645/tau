/**
 * Regression guard: worker bootstrap imports only the standalone host sibling so
 * the worker chunk emitter (`web-worker-client.ts`) never participates in its
 * own static dependency graph (`docs/research/runtime-transport-authoring-simplification.md` §R1).
 *
 * @vitest-environment node
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

describe('transport chunk emit cycle-break (R1)', () => {
  it('avoid pulling `web-worker-transport` composition into `@taucad/runtime/worker/web`', () => {
    const bootstrapPath = fileURLToPath(new URL('../worker/web.ts', import.meta.url));
    const source = readFileSync(bootstrapPath, 'utf8');

    expect(source).not.toMatch(/web-worker-transport\.js'/);
    expect(source).not.toMatch(/web-worker-transport"/);
    expect(source).toMatch(/web-worker-host\.js/);
  });
});
