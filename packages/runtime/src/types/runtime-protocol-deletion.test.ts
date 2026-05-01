/**
 * Phase 4 / R8 — `RuntimeCommand`, `RuntimeResponse`,
 * `ConfigureMemoryRequest` deletion contract.
 *
 * The pre-channel runtime modelled the wire as discriminated unions
 * (`RuntimeCommand` C→W, `RuntimeResponse` W→C, `ConfigureMemoryRequest`
 * memory bootstrap). v6 collapses these into the typed
 * {@link RuntimeProtocol} with `calls` / `notifies` / `listens` tables
 * and the `InitializeMemoryHandle` envelope. The legacy unions are
 * pure documentation of the ghost protocol and must not survive.
 *
 * Asserts that:
 *
 *   1. `RuntimeCommand`, `RuntimeResponse`, `ConfigureMemoryRequest`
 *      are NOT named exports of `@taucad/runtime` (`#index.js`) or
 *      `@taucad/runtime/types`.
 *   2. The dedicated `runtime-protocol.test-d.ts` no longer exists
 *      (its only purpose is the legacy inventory).
 */

import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import * as runtimePublic from '#index.js';
import * as typesPublic from '#types/index.js';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

describe('legacy RuntimeCommand/RuntimeResponse/ConfigureMemoryRequest removal (R8)', () => {
  for (const name of ['RuntimeCommand', 'RuntimeResponse', 'ConfigureMemoryRequest'] as const) {
    it(`@taucad/runtime does not value-export ${name}`, () => {
      const surface = runtimePublic as unknown as Record<string, unknown>;
      expect(surface[name]).toBeUndefined();
    });
    it(`@taucad/runtime/types does not value-export ${name}`, () => {
      const surface = typesPublic as unknown as Record<string, unknown>;
      expect(surface[name]).toBeUndefined();
    });
  }

  it('the legacy `runtime-protocol.test-d.ts` no longer exists', () => {
    const legacyPath = resolve(packageRoot, 'types/runtime-protocol.test-d.ts');
    expect(existsSync(legacyPath)).toBe(false);
  });
});
